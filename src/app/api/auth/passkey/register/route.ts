import { NextRequest, NextResponse } from "next/server";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildRegistrationOptions, verifyRegistration } from "@/lib/webauthn/server";
import { memoryRateLimit, redisRateLimit } from "@/lib/ratelimit";
import { captureRouteError } from "@/lib/observability/captureRouteError";

const ROUTE = "auth.passkey.register";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function unavailable() {
  return NextResponse.json(
    {
      error: "PASSKEY_SERVICE_NOT_CONFIGURED",
      message: "Passkey registration is temporarily unavailable.",
    },
    { status: 503 },
  );
}

async function checkRateLimit(
  userId: string,
  limit: number,
  prefix: string,
) {
  return (
    (await redisRateLimit(userId, limit, "10 m", prefix)) ??
    memoryRateLimit(`${prefix}:${userId}`, limit, 10 * 60_000)
  );
}

// ── GET ?action=options ────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const action = req.nextUrl.searchParams.get("action");
  if (action !== "options") {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  const { success } = await checkRateLimit(
    user.id,
    20,
    "axis:passkey-register-options",
  );
  if (!success) {
    return NextResponse.json({ error: "TOO_MANY_ATTEMPTS" }, { status: 429 });
  }

  const admin = createAdminClient();
  if (!admin) return unavailable();

  // Fetch existing credential IDs to exclude from options (prevent re-registering same device)
  const { data: existing, error: existingError } = await admin
    .from("user_passkeys")
    .select("credential_id")
    .eq("user_id", user.id);
  if (existingError) {
    captureRouteError(existingError, {
      route: ROUTE,
      operation: "list_credentials",
      area: "auth",
      status: 500,
      code: "PASSKEYS_UNAVAILABLE",
    });
    return NextResponse.json({ error: "PASSKEYS_UNAVAILABLE" }, { status: 500 });
  }

  const existingIds = (existing ?? []).map((row) => row.credential_id as string);

  const options = await buildRegistrationOptions(user.id, user.email ?? "", existingIds);

  // Remove only expired challenges. Keeping live ceremonies independent avoids
  // one browser tab invalidating another tab's in-progress registration.
  const { error: cleanupError } = await admin
    .from("webauthn_challenges")
    .delete()
    .eq("user_id", user.id)
    .eq("type", "registration")
    .lt("expires_at", new Date().toISOString());
  if (cleanupError) {
    captureRouteError(cleanupError, {
      route: ROUTE,
      operation: "cleanup_challenges",
      area: "auth",
      status: 500,
      code: "CHALLENGE_STORE_FAILED",
    });
    return NextResponse.json({ error: "CHALLENGE_STORE_FAILED" }, { status: 500 });
  }

  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const { data: storedChallenge, error: challengeError } = await admin
    .from("webauthn_challenges")
    .insert({
      challenge: options.challenge,
      type: "registration",
      user_id: user.id,
      email: user.email,
      expires_at: expiresAt,
    })
    .select("id")
    .single();

  if (challengeError || !storedChallenge) {
    captureRouteError(challengeError, {
      route: ROUTE,
      operation: "store_challenge",
      area: "auth",
      status: 500,
      code: "CHALLENGE_STORE_FAILED",
    });
    return NextResponse.json({ error: "CHALLENGE_STORE_FAILED" }, { status: 500 });
  }

  return NextResponse.json({ options, ceremonyId: storedChallenge.id });
}

// ── POST ?action=verify ────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const action = req.nextUrl.searchParams.get("action");
  if (action !== "verify") {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  const { success } = await checkRateLimit(
    user.id,
    10,
    "axis:passkey-register-verify",
  );
  if (!success) {
    return NextResponse.json({ error: "TOO_MANY_ATTEMPTS" }, { status: 429 });
  }

  let body: {
    response: RegistrationResponseJSON;
    ceremonyId: string;
    deviceName?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { response, ceremonyId, deviceName } = body;
  if (!response) {
    return NextResponse.json({ error: "Missing response" }, { status: 400 });
  }
  if (typeof ceremonyId !== "string" || !UUID_PATTERN.test(ceremonyId)) {
    return NextResponse.json({ error: "Invalid ceremonyId" }, { status: 400 });
  }

  const admin = createAdminClient();
  if (!admin) return unavailable();

  // Fetch the exact challenge issued to this ceremony, then delete that exact
  // owner-scoped row before verification so it cannot be replayed.
  const now = new Date().toISOString();
  const { data: challengeRow, error: challengeError } = await admin
    .from("webauthn_challenges")
    .select("id, challenge")
    .eq("id", ceremonyId)
    .eq("user_id", user.id)
    .eq("type", "registration")
    .gt("expires_at", now)
    .maybeSingle();
  if (challengeError) {
    captureRouteError(challengeError, {
      route: ROUTE,
      operation: "read_challenge",
      area: "auth",
      status: 500,
      code: "CHALLENGE_UNAVAILABLE",
    });
    return NextResponse.json({ error: "CHALLENGE_UNAVAILABLE" }, { status: 500 });
  }

  if (!challengeRow) {
    return NextResponse.json({ error: "CHALLENGE_EXPIRED" }, { status: 400 });
  }

  // Delete before verifying so it can't be replayed even on error
  const { data: consumedChallenge, error: consumeError } = await admin
    .from("webauthn_challenges")
    .delete()
    .eq("id", ceremonyId)
    .eq("user_id", user.id)
    .eq("type", "registration")
    .select("id")
    .maybeSingle();
  if (consumeError) {
    captureRouteError(consumeError, {
      route: ROUTE,
      operation: "consume_challenge",
      area: "auth",
      status: 500,
      code: "CHALLENGE_CONSUME_FAILED",
    });
    return NextResponse.json({ error: "CHALLENGE_CONSUME_FAILED" }, { status: 500 });
  }
  if (!consumedChallenge) {
    return NextResponse.json({ error: "CHALLENGE_ALREADY_USED" }, { status: 409 });
  }

  let verified: Awaited<ReturnType<typeof verifyRegistration>>;
  try {
    verified = await verifyRegistration(response, challengeRow.challenge);
  } catch {
    return NextResponse.json({ error: "VERIFY_FAILED" }, { status: 400 });
  }

  if (!verified.verified || !verified.registrationInfo) {
    return NextResponse.json({ error: "NOT_VERIFIED" }, { status: 400 });
  }

  const { registrationInfo } = verified;
  const publicKeyBase64 = Buffer.from(registrationInfo.credential.publicKey).toString("base64url");

  const { data: inserted, error: insertError } = await admin
    .from("user_passkeys")
    .insert({
      user_id: user.id,
      credential_id: registrationInfo.credential.id,
      credential_public_key: publicKeyBase64,
      counter: registrationInfo.credential.counter,
      device_type: response.authenticatorAttachment ?? null,
      backed_up: registrationInfo.credentialBackedUp,
      transports: response.response.transports ?? [],
      name: deviceName?.trim() || "My device",
    })
    .select("id")
    .single();

  if (insertError || !inserted) {
    captureRouteError(insertError ?? new Error("PASSKEY_CREATE_FAILED"), {
      route: ROUTE,
      operation: "create_credential",
      area: "auth",
      status: 500,
      code: "PASSKEY_CREATE_FAILED",
    });
    return NextResponse.json({ error: "PASSKEY_CREATE_FAILED" }, { status: 500 });
  }

  // Mark passkey as enabled in user auth settings
  const { error: settingsError } = await admin.from("user_auth_settings").upsert(
    {
      user_id: user.id,
      passkey_enabled: true,
      biometric_prompted: true,
    },
    { onConflict: "user_id" },
  );
  if (settingsError) {
    captureRouteError(settingsError, {
      route: ROUTE,
      operation: "update_settings",
      area: "auth",
      status: 500,
      code: "PASSKEY_SETTINGS_UPDATE_FAILED",
    });
    return NextResponse.json(
      {
        verified: true,
        passkeyId: inserted.id,
        warning: "PASSKEY_SETTINGS_UPDATE_FAILED",
      },
      { status: 201 },
    );
  }

  return NextResponse.json({ verified: true, passkeyId: inserted.id }, { status: 201 });
}
