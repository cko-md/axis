import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { admit, ADMISSION_POLICIES } from "@/lib/admission";
import { optionalEnv } from "@/lib/env";
import { MFA_TRUST_COOKIE, issueMfaTrustToken, resolveTrustWindowDays } from "@/lib/auth/mfaTrust";
import { readMfaTrustEpoch } from "@/lib/auth/securityState";
import { redactRouteError } from "@/lib/observability/redactRouteError";
import { captureRouteError } from "@/lib/observability/captureRouteError";
import { readBoundedJson } from "@/lib/http/boundedJson";
import { authProviderFailureStatus } from "@/lib/auth/providerError";

const MAX_MFA_BODY_BYTES = 8_192;
const MAX_PROVIDER_ID_CHARS = 1_024;

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError) return NextResponse.json({ error: "AUTH_BACKEND_UNAVAILABLE" }, { status: 503 });
  if (!user) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });

  const admission = await admit(user.id, ADMISSION_POLICIES.mfaVerify);
  if (admission.kind === "unavailable") return NextResponse.json({ error: "ADMISSION_UNAVAILABLE" }, { status: 503 });
  if (admission.kind === "limited") return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429, headers: { "retry-after": String(admission.retryAfterSeconds) } });

  const parsedBody = await readBoundedJson(req, MAX_MFA_BODY_BYTES);
  if (!parsedBody.ok) return NextResponse.json({ error: parsedBody.code }, { status: parsedBody.status });
  const body = parsedBody.value as { factorId?: unknown; challengeId?: unknown; code?: unknown; trustDevice?: unknown } | null;
  if (
    !body
    || typeof body.factorId !== "string"
    || body.factorId.length === 0
    || body.factorId.length > MAX_PROVIDER_ID_CHARS
    || typeof body.challengeId !== "string"
    || body.challengeId.length === 0
    || body.challengeId.length > MAX_PROVIDER_ID_CHARS
    || typeof body.code !== "string"
    || (body.trustDevice !== undefined && typeof body.trustDevice !== "boolean")
  ) {
    return NextResponse.json({ error: "INVALID_MFA_VERIFICATION" }, { status: 400 });
  }
  if (!/^\d{6}$/.test(body.code)) return NextResponse.json({ error: "INVALID_MFA_VERIFICATION" }, { status: 400 });

  // Provider verification is a mutation. Prove ownership before invoking it;
  // an unavailable factor projection must fail closed rather than skipping the
  // ownership boundary.
  let factorLookup;
  try {
    factorLookup = await supabase.auth.mfa.listFactors();
  } catch {
    return NextResponse.json({ error: "AUTH_BACKEND_UNAVAILABLE" }, { status: 503 });
  }
  if (factorLookup.error || !factorLookup.data) {
    return NextResponse.json({ error: "AUTH_BACKEND_UNAVAILABLE" }, { status: 503 });
  }
  const factor = factorLookup.data?.all?.find((candidate) => candidate.id === body.factorId);
  if (!factor) {
    return NextResponse.json({ error: "INVALID_MFA_VERIFICATION" }, { status: 400 });
  }

  let verifyResult;
  try {
    verifyResult = await supabase.auth.mfa.verify({ factorId: body.factorId, challengeId: body.challengeId, code: body.code });
  } catch {
    return redactRouteError(new Error("MFA verification provider unavailable"), {
      route: "auth/mfa/verify", area: "auth", status: 503,
      code: "AUTH_BACKEND_UNAVAILABLE", message: "MFA verification is temporarily unavailable",
    });
  }
  const { error } = verifyResult;
  if (error) {
    const status = authProviderFailureStatus(error);
    return redactRouteError(new Error("MFA verification provider failed"), {
      route: "auth/mfa/verify", area: "auth", status,
      code: status === 503 ? "AUTH_BACKEND_UNAVAILABLE" : "MFA_VERIFICATION_REJECTED",
      message: status === 503 ? "MFA verification is temporarily unavailable" : "MFA verification failed",
    });
  }

  let settingsError: unknown = null;
  try {
    const settingsResult = await supabase.from("user_auth_settings").upsert({
      user_id: user.id, twofa_enabled: true, twofa_method: factor.factor_type === "phone" ? "sms" : "totp", updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });
    settingsError = settingsResult.error;
  } catch {
    settingsError = { code: "AUTH_SETTINGS_UNAVAILABLE" };
  }
  const settingsPending = Boolean(settingsError);
  if (settingsError) {
    captureRouteError(new Error("MFA settings sync pending after successful verification"), {
      route: "auth/mfa/verify", operation: "sync_settings", area: "auth",
      status: 503, code: "AUTH_PROJECTION_PENDING",
    });
  }

  const response = NextResponse.json({
    verified: true,
    trusted: false,
    ...(settingsPending ? { settings_sync: "pending" } : {}),
  });
  if (body.trustDevice !== true) return response;
  if (!factor) return response;
  const epoch = await readMfaTrustEpoch(supabase, user.id);
  if (epoch === null) return response;
  const issued = await issueMfaTrustToken({
    secret: optionalEnv("MFA_TRUST_SECRET"), userId: user.id, factorId: factor.id, trustEpoch: epoch,
    nowMs: Date.now(), windowDays: resolveTrustWindowDays(optionalEnv("MFA_TRUST_WINDOW_DAYS")),
  });
  if (!issued) return response;
  response.cookies.set(MFA_TRUST_COOKIE, issued.token, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", maxAge: issued.maxAgeSeconds, path: "/" });
  return response;
}
