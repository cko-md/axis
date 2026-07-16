import { NextRequest, NextResponse } from "next/server";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildAuthenticationOptions, verifyAuthentication } from "@/lib/webauthn/server";
import { memoryRateLimit, redisRateLimit } from "@/lib/ratelimit";
import { captureRouteError } from "@/lib/observability/captureRouteError";

const ROUTE = "auth.passkey.authenticate";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requestIp(req: NextRequest) {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "anonymous";
}

async function checkRateLimit(
  req: NextRequest,
  limit: number,
  prefix: string,
) {
  const ip = requestIp(req);
  return (
    (await redisRateLimit(ip, limit, "10 m", prefix)) ??
    memoryRateLimit(`${prefix}:${ip}`, limit, 10 * 60_000)
  );
}

function unavailable() {
  return NextResponse.json(
    {
      error: "PASSKEY_SERVICE_NOT_CONFIGURED",
      message: "Passkey authentication is temporarily unavailable.",
    },
    { status: 503 },
  );
}

// ── GET ?action=options ────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const action = req.nextUrl.searchParams.get("action");
  if (action !== "options") {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }

  const { success } = await checkRateLimit(req, 20, "axis:passkey-options");
  if (!success) {
    return NextResponse.json(
      { error: "Too many attempts. Please wait before trying again." },
      { status: 429 },
    );
  }

  // Pre-auth flow has no user session, so it requires the trusted service role.
  const admin = createAdminClient();
  if (!admin) return unavailable();

  // Clean up stale authentication challenges before creating a new one
  const { error: cleanupError } = await admin
    .from("webauthn_challenges")
    .delete()
    .eq("type", "authentication")
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

  // Discoverable credential flow — empty allowCredentials lets any resident key respond
  const options = await buildAuthenticationOptions([]);

  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const { data: storedChallenge, error: challengeError } = await admin
    .from("webauthn_challenges")
    .insert({
      challenge: options.challenge,
      type: "authentication",
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

  const { success } = await checkRateLimit(req, 10, "axis:passkey-verify");
  if (!success) {
    return NextResponse.json({ error: "Too many attempts. Please wait before trying again." }, { status: 429 });
  }

  let body: { response: AuthenticationResponseJSON; ceremonyId: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { response, ceremonyId } = body;
  if (!response) {
    return NextResponse.json({ error: "Missing response" }, { status: 400 });
  }
  if (typeof ceremonyId !== "string" || !UUID_PATTERN.test(ceremonyId)) {
    return NextResponse.json({ error: "Invalid ceremonyId" }, { status: 400 });
  }

  const admin = createAdminClient();
  if (!admin) return unavailable();

  // Decode userHandle from the assertion response to get userId
  const userHandleB64 = response.response.userHandle;
  let userId: string | null = null;
  if (userHandleB64) {
    try {
      userId = Buffer.from(userHandleB64, "base64url").toString("utf8");
    } catch {
      // Will still look up by credential_id below
    }
  }

  // Look up the passkey by credential_id (response.id is the credential ID)
  const { data: passkey, error: passkeyError } = await admin
    .from("user_passkeys")
    .select(
      "id, user_id, credential_id, credential_public_key, counter, transports",
    )
    .eq("credential_id", response.id)
    .maybeSingle();

  if (passkeyError) {
    captureRouteError(passkeyError, {
      route: ROUTE,
      operation: "read_credential",
      area: "auth",
      status: 500,
      code: "PASSKEY_UNAVAILABLE",
    });
    return NextResponse.json({ error: "PASSKEY_UNAVAILABLE" }, { status: 500 });
  }
  if (!passkey) {
    return NextResponse.json({ error: "Passkey not found" }, { status: 404 });
  }

  // Reconcile userId: prefer the decoded userHandle, fall back to passkey.user_id
  const resolvedUserId: string = userId ?? passkey.user_id;

  // Sanity check: decoded userId must match the passkey's owner
  if (userId && userId !== passkey.user_id) {
    return NextResponse.json({ error: "Credential mismatch" }, { status: 400 });
  }

  // Fetch only the challenge issued to this browser ceremony. Authentication
  // challenges are intentionally unbound to user_id because this is pre-auth.
  const now = new Date().toISOString();
  const { data: challengeRow, error: challengeError } = await admin
    .from("webauthn_challenges")
    .select("id, challenge")
    .eq("id", ceremonyId)
    .eq("type", "authentication")
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

  // Delete challenge immediately (one-time use)
  const { data: consumedChallenge, error: consumeError } = await admin
    .from("webauthn_challenges")
    .delete()
    .eq("id", ceremonyId)
    .eq("type", "authentication")
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

  let verified: Awaited<ReturnType<typeof verifyAuthentication>>;
  try {
    verified = await verifyAuthentication(response, challengeRow.challenge, {
      credentialId: passkey.credential_id,
      credentialPublicKey: passkey.credential_public_key,
      counter: passkey.counter,
      transports: passkey.transports ?? [],
    });
  } catch {
    return NextResponse.json({ error: "VERIFY_FAILED" }, { status: 400 });
  }

  if (!verified.verified) {
    return NextResponse.json({ error: "NOT_VERIFIED" }, { status: 400 });
  }

  // Persist the authenticator counter through the trusted boundary. Expected
  // owner + counter fencing rejects cloned/replayed concurrent assertions.
  const { data: updatedPasskey, error: counterError } = await admin
    .from("user_passkeys")
    .update({
      counter: verified.authenticationInfo.newCounter,
      last_used_at: new Date().toISOString(),
    })
    .eq("id", passkey.id)
    .eq("user_id", passkey.user_id)
    .eq("counter", passkey.counter)
    .select("id")
    .maybeSingle();
  if (counterError) {
    captureRouteError(counterError, {
      route: ROUTE,
      operation: "update_counter",
      area: "auth",
      status: 500,
      code: "PASSKEY_COUNTER_UPDATE_FAILED",
    });
    return NextResponse.json({ error: "PASSKEY_COUNTER_UPDATE_FAILED" }, { status: 500 });
  }
  if (!updatedPasskey) {
    return NextResponse.json({ error: "PASSKEY_COUNTER_CONFLICT" }, { status: 409 });
  }

  const { data: ownerData, error: ownerError } =
    await admin.auth.admin.getUserById(passkey.user_id);
  const owner = ownerData?.user;
  if (ownerError || !owner?.email) {
    captureRouteError(new Error("Passkey owner lookup failed"), {
      route: ROUTE,
      operation: "read_passkey_owner",
      area: "auth",
      status: 500,
      code: "PASSKEY_SESSION_UNAVAILABLE",
      tags: { provider_code: ownerError?.code },
    });
    return NextResponse.json(
      {
        error: "PASSKEY_SESSION_UNAVAILABLE",
        message: "Passkey authentication is temporarily unavailable.",
      },
      { status: 503 },
    );
  }

  // Mint a fresh, one-time Supabase email token only after WebAuthn and the
  // counter CAS succeed. The token hash remains server-side and is consumed
  // immediately by the SSR client so normal sign-out can revoke old sessions.
  const { data: linkData, error: linkError } =
    await admin.auth.admin.generateLink({
      type: "magiclink",
      email: owner.email,
    });
  if (linkError || !linkData?.user || !linkData.properties?.hashed_token) {
    captureRouteError(new Error("Passkey one-time session mint failed"), {
      route: ROUTE,
      operation: "mint_one_time_session",
      area: "auth",
      status: 500,
      code: "PASSKEY_SESSION_UNAVAILABLE",
      tags: { provider_code: linkError?.code },
    });
    return NextResponse.json(
      {
        error: "PASSKEY_SESSION_UNAVAILABLE",
        message: "Passkey authentication is temporarily unavailable.",
      },
      { status: 503 },
    );
  }
  if (linkData.user.id !== passkey.user_id) {
    captureRouteError(new Error("Passkey one-time session owner mismatch"), {
      route: ROUTE,
      operation: "validate_minted_session_owner",
      area: "auth",
      status: 500,
      code: "PASSKEY_SESSION_OWNER_MISMATCH",
    });
    return NextResponse.json(
      {
        error: "PASSKEY_SESSION_OWNER_MISMATCH",
        message: "Passkey authentication could not verify the session owner.",
      },
      { status: 409 },
    );
  }

  // Consuming the hash through the SSR client writes the new auth cookies.
  // Neither the link nor its token hash is returned, logged, or persisted.
  const sessionClient = await createClient();
  const {
    data: { session },
    error: verifyOtpError,
  } = await sessionClient.auth.verifyOtp({
    token_hash: linkData.properties.hashed_token,
    type: "magiclink",
  });
  if (verifyOtpError || !session) {
    captureRouteError(new Error("Passkey one-time session verification failed"), {
      route: ROUTE,
      operation: "verify_one_time_session",
      area: "auth",
      status: 500,
      code: "PASSKEY_SESSION_UNAVAILABLE",
      tags: { provider_code: verifyOtpError?.code },
    });
    return NextResponse.json(
      {
        error: "PASSKEY_SESSION_UNAVAILABLE",
        message: "Passkey authentication is temporarily unavailable.",
      },
      { status: 503 },
    );
  }
  if (
    session.user.id !== passkey.user_id ||
    session.user.id !== resolvedUserId
  ) {
    const { error: signOutError } = await sessionClient.auth.signOut({ scope: "local" });
    captureRouteError(new Error("Passkey-restored session owner mismatch"), {
      route: ROUTE,
      operation: "validate_restored_session_owner",
      area: "auth",
      status: 500,
      code: "PASSKEY_SESSION_OWNER_MISMATCH",
      tags: { local_session_cleared: !signOutError },
    });
    return NextResponse.json(
      {
        error: "PASSKEY_SESSION_OWNER_MISMATCH",
        message: "Passkey authentication could not verify the session owner.",
      },
      { status: 409 },
    );
  }

  return NextResponse.json({
    verified: true,
    userId: resolvedUserId,
  });
}
