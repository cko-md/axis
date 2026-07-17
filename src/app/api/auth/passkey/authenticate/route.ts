import { NextRequest, NextResponse } from "next/server";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { captureRouteError } from "@/lib/observability/captureRouteError";
import { memoryRateLimit, redisRateLimit } from "@/lib/ratelimit";
import {
  commitPasskeyAuthentication,
  consumeWebAuthnChallenge,
} from "@/lib/security/passkeyMutations";
import { buildAuthenticationOptions, verifyAuthentication } from "@/lib/webauthn/server";

const ROUTE = "passkey_authenticate";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isAuthenticationResponse(
  value: unknown,
): value is AuthenticationResponseJSON {
  if (!value || typeof value !== "object") return false;
  const candidate = value as {
    id?: unknown;
    response?: unknown;
  };
  return typeof candidate.id === "string"
    && candidate.id.length > 0
    && Boolean(candidate.response)
    && typeof candidate.response === "object";
}

function requestIp(req: NextRequest) {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || req.headers.get("x-real-ip")?.trim()
    || "anonymous";
}

async function withinRateLimit(
  ip: string,
  operation: "options" | "verify",
  limit: number,
) {
  return (
    (await redisRateLimit(ip, limit, "10 m", `axis:passkey-auth-${operation}`))
    ?? memoryRateLimit(`passkey-auth-${operation}:${ip}`, limit, 10 * 60_000)
  ).success;
}

// ── GET ?action=options ────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get("action") !== "options") {
    return NextResponse.json({ error: "UNKNOWN_ACTION" }, { status: 400 });
  }
  if (!(await withinRateLimit(requestIp(req), "options", 20))) {
    return NextResponse.json({ error: "TOO_MANY_ATTEMPTS" }, { status: 429 });
  }
  const admin = createAdminClient();
  if (!admin) {
    captureRouteError(new Error("Passkey authentication service role unavailable"), {
      route: ROUTE,
      operation: "options",
      area: "auth",
      status: 503,
      code: "PASSKEY_SERVICE_UNAVAILABLE",
    });
    return NextResponse.json({ error: "PASSKEY_SERVICE_UNAVAILABLE" }, { status: 503 });
  }

  let options: Awaited<ReturnType<typeof buildAuthenticationOptions>>;
  try {
    options = await buildAuthenticationOptions([]);
  } catch {
    captureRouteError(new Error("Passkey authentication options generation failed"), {
      route: ROUTE,
      operation: "build_options",
      area: "auth",
      status: 500,
      code: "PASSKEY_OPTIONS_FAILED",
    });
    return NextResponse.json({ error: "PASSKEY_OPTIONS_FAILED" }, { status: 500 });
  }

  const { data: challengeRow, error: challengeError } = await admin
    .from("webauthn_challenges")
    .insert({
      challenge: options.challenge,
      type: "authentication",
      expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    })
    .select("id")
    .single();
  if (challengeError || !challengeRow) {
    captureRouteError(new Error("Passkey authentication challenge insert failed"), {
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
  if (!(await withinRateLimit(requestIp(req), "verify", 10))) {
    return NextResponse.json({ error: "TOO_MANY_ATTEMPTS" }, { status: 429 });
  }
  const body = (await req.json().catch(() => null)) as {
    response?: AuthenticationResponseJSON;
    challengeId?: unknown;
  } | null;
  if (!isAuthenticationResponse(body?.response)) {
    return NextResponse.json({ error: "INVALID_RESPONSE" }, { status: 400 });
  }
  if (typeof body.challengeId !== "string" || !UUID_RE.test(body.challengeId)) {
    return NextResponse.json({ error: "MISSING_CHALLENGE_ID" }, { status: 400 });
  }

  const admin = createAdminClient();
  if (!admin) {
    captureRouteError(new Error("Passkey authentication service role unavailable"), {
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
    type: "authentication",
    userId: null,
    now: new Date().toISOString(),
  }, admin);
  if (!consumed.ok) {
    if (consumed.code === "NOT_FOUND") {
      return NextResponse.json({ error: "CHALLENGE_EXPIRED" }, { status: 400 });
    }
    captureRouteError(new Error("Passkey authentication challenge consume failed"), {
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

  const { data: passkey, error: passkeyError } = await admin
    .from("user_passkeys")
    .select(
      "id, user_id, credential_id, credential_public_key, counter, transports, last_used_at",
    )
    .eq("credential_id", body.response.id)
    .maybeSingle();
  if (passkeyError) {
    captureRouteError(new Error("Passkey authentication credential lookup failed"), {
      route: ROUTE,
      operation: "load_passkey",
      area: "auth",
      status: 500,
      code: "PASSKEYS_UNAVAILABLE",
    });
    return NextResponse.json({ error: "PASSKEYS_UNAVAILABLE" }, { status: 500 });
  }
  if (!passkey) {
    return NextResponse.json({ error: "PASSKEY_AUTHENTICATION_FAILED" }, { status: 400 });
  }

  const userHandle = body.response.response.userHandle;
  if (userHandle !== undefined && userHandle !== null) {
    if (typeof userHandle !== "string") {
      return NextResponse.json({ error: "PASSKEY_AUTHENTICATION_FAILED" }, { status: 400 });
    }
    let decodedUserId: string;
    try {
      decodedUserId = Buffer.from(userHandle, "base64url").toString("utf8");
    } catch {
      return NextResponse.json({ error: "PASSKEY_AUTHENTICATION_FAILED" }, { status: 400 });
    }
    if (decodedUserId !== passkey.user_id) {
      return NextResponse.json({ error: "PASSKEY_AUTHENTICATION_FAILED" }, { status: 400 });
    }
  }

  let verified: Awaited<ReturnType<typeof verifyAuthentication>>;
  try {
    verified = await verifyAuthentication(body.response, consumed.challenge, {
      credentialId: passkey.credential_id,
      credentialPublicKey: passkey.credential_public_key,
      counter: passkey.counter,
      transports: passkey.transports ?? [],
    });
  } catch {
    return NextResponse.json({ error: "PASSKEY_AUTHENTICATION_FAILED" }, { status: 400 });
  }
  if (!verified.verified) {
    return NextResponse.json({ error: "PASSKEY_AUTHENTICATION_FAILED" }, { status: 400 });
  }

  const committed = await commitPasskeyAuthentication({
    userId: passkey.user_id,
    passkeyId: passkey.id,
    expectedCounter: passkey.counter,
    newCounter: verified.authenticationInfo.newCounter,
    expectedLastUsedAt: passkey.last_used_at,
    usedAt: new Date().toISOString(),
  }, admin);
  if (!committed.ok) {
    if (committed.code === "COUNTER_CONFLICT") {
      return NextResponse.json({ error: "PASSKEY_COUNTER_CONFLICT" }, { status: 409 });
    }
    if (committed.code === "PASSKEY_NOT_FOUND") {
      return NextResponse.json({ error: "PASSKEY_AUTHENTICATION_FAILED" }, { status: 400 });
    }
    captureRouteError(new Error("Passkey authentication commit failed"), {
      route: ROUTE,
      operation: "commit_authentication",
      area: "auth",
      status: committed.code === "SERVICE_UNAVAILABLE" ? 503 : 500,
      code: "PASSKEY_COMMIT_FAILED",
    });
    return NextResponse.json(
      { error: "PASSKEY_COMMIT_FAILED" },
      { status: committed.code === "SERVICE_UNAVAILABLE" ? 503 : 500 },
    );
  }

  // WebAuthn establishes possession; Supabase Auth remains the session issuer.
  // Generate a server-only one-time magic-link hash for the credential owner,
  // then redeem it directly into server-managed cookies. No link/hash/session
  // token is returned to or accepted from the browser.
  const { data: ownerData, error: ownerError } =
    await admin.auth.admin.getUserById(passkey.user_id);
  const owner = ownerData.user;
  if (ownerError || !owner || !owner.email) {
    captureRouteError(new Error("Passkey owner lookup failed"), {
      route: ROUTE,
      operation: "load_session_owner",
      area: "auth",
      status: 503,
      code: "PASSKEY_SESSION_UNAVAILABLE",
    });
    return NextResponse.json({ error: "PASSKEY_SESSION_UNAVAILABLE" }, { status: 503 });
  }

  const { data: linkData, error: linkError } =
    await admin.auth.admin.generateLink({
      type: "magiclink",
      email: owner.email,
    });
  const tokenHash = linkData.properties?.hashed_token;
  if (
    linkError
    || linkData.user?.id !== passkey.user_id
    || typeof tokenHash !== "string"
    || !tokenHash
  ) {
    captureRouteError(new Error("Passkey session link issuance failed"), {
      route: ROUTE,
      operation: "issue_session",
      area: "auth",
      status: 503,
      code: "PASSKEY_SESSION_UNAVAILABLE",
    });
    return NextResponse.json({ error: "PASSKEY_SESSION_UNAVAILABLE" }, { status: 503 });
  }

  const cookieClient = await createClient();
  const { data: cookieSessionData, error: cookieSessionError } =
    await cookieClient.auth.verifyOtp({
      type: "magiclink",
      token_hash: tokenHash,
    });
  if (
    cookieSessionError
    || !cookieSessionData.session
    || cookieSessionData.session.user.id !== passkey.user_id
  ) {
    const { error: clearError } = await cookieClient.auth.signOut({ scope: "local" });
    if (clearError) {
      captureRouteError(new Error("Passkey failed session cookie cleanup"), {
        route: ROUTE,
        operation: "clear_session",
        area: "auth",
        status: 500,
        code: "PASSKEY_SESSION_CLEANUP_FAILED",
      });
    }
    captureRouteError(new Error("Passkey session cookie issuance failed"), {
      route: ROUTE,
      operation: "redeem_session",
      area: "auth",
      status: 503,
      code: "PASSKEY_SESSION_UNAVAILABLE",
    });
    return NextResponse.json({ error: "PASSKEY_SESSION_UNAVAILABLE" }, { status: 503 });
  }

  // Re-open the cookie-backed client and ask Supabase Auth to verify the user;
  // do not report success based only on the OTP redemption return value.
  const verificationClient = await createClient();
  const {
    data: { user: cookieUser },
    error: cookieUserError,
  } = await verificationClient.auth.getUser();
  if (cookieUserError || !cookieUser || cookieUser.id !== passkey.user_id) {
    const { error: clearError } = await cookieClient.auth.signOut({ scope: "local" });
    if (clearError) {
      captureRouteError(new Error("Passkey failed invalid-session cookie cleanup"), {
        route: ROUTE,
        operation: "clear_session",
        area: "auth",
        status: 500,
        code: "PASSKEY_SESSION_CLEANUP_FAILED",
      });
    }
    captureRouteError(new Error("Passkey cookie-backed identity verification failed"), {
      route: ROUTE,
      operation: "verify_cookie_session",
      area: "auth",
      status: 503,
      code: "PASSKEY_SESSION_UNAVAILABLE",
    });
    return NextResponse.json({ error: "PASSKEY_SESSION_UNAVAILABLE" }, { status: 503 });
  }

  return NextResponse.json({ verified: true });
}
