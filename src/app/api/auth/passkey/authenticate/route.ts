import { NextRequest, NextResponse } from "next/server";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { captureRouteError } from "@/lib/observability/captureRouteError";
import { admit, ADMISSION_POLICIES } from "@/lib/admission";
import {
  commitPasskeyAuthentication,
  consumeWebAuthnChallenge,
} from "@/lib/security/passkeyMutations";
import { buildAuthenticationOptions, verifyAuthentication } from "@/lib/webauthn/server";
import { optionalEnv } from "@/lib/env";
import {
  MFA_TRUST_COOKIE,
  issueMfaTrustToken,
  resolveTrustWindowDays,
} from "@/lib/auth/mfaTrust";
import { readMfaTrustEpoch } from "@/lib/auth/securityState";
import { readBoundedJson } from "@/lib/http/boundedJson";

const ROUTE = "passkey_authenticate";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_AUTH_BODY_BYTES = 32_768;
const MAX_CREDENTIAL_ID_CHARS = 1_024;
// This broad pre-identity ceiling limits anonymous spray while leaving the
// owner-bound quota below as the tight authority once a credential is known.
const PASSKEY_AUTHENTICATION_GLOBAL_CAPACITY = 300;

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
    && candidate.id.length <= MAX_CREDENTIAL_ID_CHARS
    && Boolean(candidate.response)
    && typeof candidate.response === "object";
}

// ── GET ?action=options ────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get("action") !== "options") {
    return NextResponse.json({ error: "UNKNOWN_ACTION" }, { status: 400 });
  }
  const admission = await admit("passkey-authentication-options", {
    ...ADMISSION_POLICIES.passkeyRegister,
    name: "passkey-auth-options-global",
    limit: PASSKEY_AUTHENTICATION_GLOBAL_CAPACITY,
  });
  if (admission.kind === "unavailable") return NextResponse.json({ error: "ADMISSION_UNAVAILABLE" }, { status: 503 });
  if (admission.kind === "limited") return NextResponse.json({ error: "TOO_MANY_ATTEMPTS" }, { status: 429, headers: { "retry-after": String(admission.retryAfterSeconds) } });
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
  const preAdmission = await admit("passkey-authentication-verify", {
    ...ADMISSION_POLICIES.passkeyRegister,
    name: "passkey-auth-verify-global",
    limit: PASSKEY_AUTHENTICATION_GLOBAL_CAPACITY,
  });
  if (preAdmission.kind === "unavailable") return NextResponse.json({ error: "ADMISSION_UNAVAILABLE" }, { status: 503 });
  if (preAdmission.kind === "limited") return NextResponse.json({ error: "TOO_MANY_ATTEMPTS" }, { status: 429, headers: { "retry-after": String(preAdmission.retryAfterSeconds) } });
  const parsedBody = await readBoundedJson(req, MAX_AUTH_BODY_BYTES);
  if (!parsedBody.ok) {
    return NextResponse.json(
      { error: parsedBody.code },
      { status: parsedBody.status },
    );
  }
  const body = parsedBody.value as {
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
  const ownerAdmission = await admit(passkey.user_id, { ...ADMISSION_POLICIES.passkeyRegister, name: "passkey-auth-owner", limit: 10 });
  if (ownerAdmission.kind === "unavailable") return NextResponse.json({ error: "ADMISSION_UNAVAILABLE" }, { status: 503 });
  if (ownerAdmission.kind === "limited") return NextResponse.json({ error: "TOO_MANY_ATTEMPTS" }, { status: 429, headers: { "retry-after": String(ownerAdmission.retryAfterSeconds) } });

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

  const response = NextResponse.json({ verified: true });

  // Policy: a verified passkey assertion (userVerification is 'required', so
  // the authenticator demanded biometrics or a PIN) counts as the second
  // factor. Without this, a passkey sign-in lands at aal1 and an account with
  // TOTP enrolled is immediately challenged for a code — a strictly weaker
  // factor than the ceremony that just succeeded. Minting the same
  // remembered-device token an authenticator code would earn lets middleware
  // treat this device as satisfied for the trust window.
  //
  // Bounded and non-fatal: requires MFA_TRUST_SECRET (absent => no cookie, the
  // TOTP challenge appears as before), binds to the account's verified factor
  // so unenrolling/re-enrolling invalidates it, and never touches the
  // per-approval WebAuthn step-up path, which ignores assurance entirely.
  try {
    const { data: factorsData, error: factorsError } =
      await admin.auth.admin.mfa.listFactors({
      userId: passkey.user_id,
    });
    if (factorsError) throw new Error("MFA factor projection unavailable");
    const verifiedFactor = (factorsData?.factors ?? []).find(
      (factor: { id: string; status: string }) => factor.status === "verified",
    );
    if (verifiedFactor) {
      const trustEpoch = await readMfaTrustEpoch(verificationClient, passkey.user_id);
      const issued = trustEpoch === null ? null : await issueMfaTrustToken({
        secret: optionalEnv("MFA_TRUST_SECRET"),
        userId: passkey.user_id,
        factorId: verifiedFactor.id,
        trustEpoch,
        nowMs: Date.now(),
        windowDays: resolveTrustWindowDays(optionalEnv("MFA_TRUST_WINDOW_DAYS")),
      });
      if (issued) {
        response.cookies.set(MFA_TRUST_COOKIE, issued.token, {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "lax",
          maxAge: issued.maxAgeSeconds,
          path: "/",
        });
      }
    }
  } catch {
    // Trust is a convenience; the sign-in itself already succeeded, but a
    // failed remember-device projection must remain observable.
    captureRouteError(new Error("Passkey remembered-device projection failed"), {
      route: ROUTE,
      operation: "issue_mfa_trust",
      area: "auth",
      status: 503,
      code: "MFA_TRUST_PROJECTION_FAILED",
    });
  }

  return response;
}
