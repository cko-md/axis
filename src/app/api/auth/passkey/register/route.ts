import { NextRequest, NextResponse } from "next/server";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { captureRouteError } from "@/lib/observability/captureRouteError";
import {
  consumeWebAuthnChallenge,
  createUserPasskey,
  normalizeAuthenticatorAttachment,
} from "@/lib/security/passkeyMutations";
import { buildRegistrationOptions, verifyRegistration } from "@/lib/webauthn/server";
import { admit, ADMISSION_POLICIES } from "@/lib/admission";
import { rotateMfaTrustEpoch } from "@/lib/auth/securityState";
import { readBoundedJson } from "@/lib/http/boundedJson";

const ROUTE = "passkey_register";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_REGISTRATION_BODY_BYTES = 65_536;
const MAX_CREDENTIAL_ID_CHARS = 1_024;
const MAX_DEVICE_NAME_CHARS = 100;

function isRegistrationResponse(
  value: unknown,
): value is RegistrationResponseJSON {
  if (!value || typeof value !== "object") return false;
  const candidate = value as {
    id?: unknown;
    rawId?: unknown;
    response?: unknown;
  };
  return typeof candidate.id === "string"
    && candidate.id.length > 0
    && candidate.id.length <= MAX_CREDENTIAL_ID_CHARS
    && typeof candidate.rawId === "string"
    && candidate.rawId === candidate.id
    && candidate.rawId.length <= MAX_CREDENTIAL_ID_CHARS
    && Boolean(candidate.response)
    && typeof candidate.response === "object";
}

function safeDeviceName(value: unknown) {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, 100)
    : "My device";
}

// ── GET ?action=options ────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get("action") !== "options") {
    return NextResponse.json({ error: "UNKNOWN_ACTION" }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError) return NextResponse.json({ error: "AUTH_BACKEND_UNAVAILABLE" }, { status: 503 });
  if (!user) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  const admission = await admit(user.id, ADMISSION_POLICIES.passkeyRegister);
  if (admission.kind === "unavailable") return NextResponse.json({ error: "ADMISSION_UNAVAILABLE" }, { status: 503 });
  if (admission.kind === "limited") return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429, headers: { "retry-after": String(admission.retryAfterSeconds) } });

  const { data: existing, error: existingError } = await supabase
    .from("user_passkeys")
    .select("credential_id")
    .eq("user_id", user.id);
  if (existingError) {
    captureRouteError(new Error("Passkey registration credential lookup failed"), {
      route: ROUTE,
      operation: "load_credentials",
      area: "auth",
      status: 500,
      code: "PASSKEYS_UNAVAILABLE",
    });
    return NextResponse.json({ error: "PASSKEYS_UNAVAILABLE" }, { status: 500 });
  }

  let options: Awaited<ReturnType<typeof buildRegistrationOptions>>;
  try {
    options = await buildRegistrationOptions(
      user.id,
      user.email ?? user.id,
      (existing ?? []).map((row) => row.credential_id),
    );
  } catch {
    captureRouteError(new Error("Passkey registration options generation failed"), {
      route: ROUTE,
      operation: "build_options",
      area: "auth",
      status: 500,
      code: "PASSKEY_OPTIONS_FAILED",
    });
    return NextResponse.json({ error: "PASSKEY_OPTIONS_FAILED" }, { status: 500 });
  }

  const admin = createAdminClient();
  if (!admin) {
    captureRouteError(new Error("Passkey registration service role unavailable"), {
      route: ROUTE,
      operation: "store_challenge",
      area: "auth",
      status: 503,
      code: "PASSKEY_SERVICE_UNAVAILABLE",
    });
    return NextResponse.json({ error: "PASSKEY_SERVICE_UNAVAILABLE" }, { status: 503 });
  }

  const { data: challengeRow, error: challengeError } = await admin
    .from("webauthn_challenges")
    .insert({
      challenge: options.challenge,
      type: "registration",
      user_id: user.id,
      expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    })
    .select("id")
    .single();
  if (challengeError || !challengeRow) {
    captureRouteError(new Error("Passkey registration challenge insert failed"), {
      route: ROUTE,
      operation: "store_challenge",
      area: "auth",
      status: 500,
      code: "CHALLENGE_STORE_FAILED",
    });
    return NextResponse.json({ error: "CHALLENGE_STORE_FAILED" }, { status: 500 });
  }

  return NextResponse.json({ options, challengeId: challengeRow.id });
}

// ── POST ?action=verify ───────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  if (req.nextUrl.searchParams.get("action") !== "verify") {
    return NextResponse.json({ error: "UNKNOWN_ACTION" }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError) return NextResponse.json({ error: "AUTH_BACKEND_UNAVAILABLE" }, { status: 503 });
  if (!user) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  const admission = await admit(user.id, ADMISSION_POLICIES.passkeyRegister);
  if (admission.kind === "unavailable") return NextResponse.json({ error: "ADMISSION_UNAVAILABLE" }, { status: 503 });
  if (admission.kind === "limited") return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429, headers: { "retry-after": String(admission.retryAfterSeconds) } });

  const parsedBody = await readBoundedJson(req, MAX_REGISTRATION_BODY_BYTES);
  if (!parsedBody.ok) return NextResponse.json({ error: parsedBody.code }, { status: parsedBody.status });
  const body = parsedBody.value as {
    response?: RegistrationResponseJSON;
    deviceName?: unknown;
    challengeId?: unknown;
  } | null;
  if (!isRegistrationResponse(body?.response)) {
    return NextResponse.json({ error: "INVALID_RESPONSE" }, { status: 400 });
  }
  if (typeof body.challengeId !== "string" || !UUID_RE.test(body.challengeId)) {
    return NextResponse.json({ error: "MISSING_CHALLENGE_ID" }, { status: 400 });
  }
  if (
    body.deviceName !== undefined
    && (typeof body.deviceName !== "string" || body.deviceName.length > MAX_DEVICE_NAME_CHARS)
  ) {
    return NextResponse.json({ error: "INVALID_DEVICE_NAME" }, { status: 400 });
  }

  const admin = createAdminClient();
  if (!admin) {
    captureRouteError(new Error("Passkey registration service role unavailable"), {
      route: ROUTE,
      operation: "verify",
      area: "auth",
      status: 503,
      code: "PASSKEY_SERVICE_UNAVAILABLE",
    });
    return NextResponse.json({ error: "PASSKEY_SERVICE_UNAVAILABLE" }, { status: 503 });
  }

  const consumed = await consumeWebAuthnChallenge({
    challengeId: body.challengeId,
    type: "registration",
    userId: user.id,
    now: new Date().toISOString(),
  }, admin);
  if (!consumed.ok) {
    if (consumed.code === "NOT_FOUND") {
      return NextResponse.json({ error: "CHALLENGE_EXPIRED" }, { status: 400 });
    }
    captureRouteError(new Error("Passkey registration challenge consume failed"), {
      route: ROUTE,
      operation: "consume_challenge",
      area: "auth",
      status: consumed.code === "SERVICE_UNAVAILABLE" ? 503 : 500,
      code: "CHALLENGE_CONSUME_FAILED",
    });
    return NextResponse.json(
      { error: "CHALLENGE_CONSUME_FAILED" },
      { status: consumed.code === "SERVICE_UNAVAILABLE" ? 503 : 500 },
    );
  }

  let verified: Awaited<ReturnType<typeof verifyRegistration>>;
  try {
    verified = await verifyRegistration(body.response, consumed.challenge);
  } catch {
    return NextResponse.json({ error: "PASSKEY_VERIFICATION_FAILED" }, { status: 400 });
  }
  if (!verified.verified || !verified.registrationInfo) {
    return NextResponse.json({ error: "PASSKEY_VERIFICATION_FAILED" }, { status: 400 });
  }

  const { registrationInfo } = verified;
  const publicKeyBase64 = Buffer.from(
    registrationInfo.credential.publicKey,
  ).toString("base64url");
  if (await rotateMfaTrustEpoch(supabase, ROUTE) === null) {
    return NextResponse.json({ error: "SECURITY_STATE_UNAVAILABLE" }, { status: 503 });
  }
  const created = await createUserPasskey({
    userId: user.id,
    credentialId: registrationInfo.credential.id,
    credentialPublicKey: publicKeyBase64,
    counter: registrationInfo.credential.counter,
    deviceType: normalizeAuthenticatorAttachment(
      body.response.authenticatorAttachment,
    ),
    backedUp: registrationInfo.credentialBackedUp,
    transports: body.response.response.transports ?? [],
    name: safeDeviceName(body.deviceName),
  }, admin);
  if (!created.ok) {
    if (created.code === "CREDENTIAL_EXISTS") {
      return NextResponse.json({ error: "PASSKEY_ALREADY_REGISTERED" }, { status: 409 });
    }
    captureRouteError(new Error("Atomic passkey registration failed"), {
      route: ROUTE,
      operation: "create_passkey",
      area: "auth",
      status: created.code === "SERVICE_UNAVAILABLE" ? 503 : 500,
      code: "PASSKEY_CREATE_FAILED",
    });
    return NextResponse.json(
      { error: "PASSKEY_CREATE_FAILED" },
      { status: created.code === "SERVICE_UNAVAILABLE" ? 503 : 500 },
    );
  }

  return NextResponse.json({ verified: true, passkeyId: created.passkeyId });
}
