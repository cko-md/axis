import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { redactRouteError } from "@/lib/observability/redactRouteError";
import { MFA_TRUST_COOKIE } from "@/lib/auth/mfaTrust";
import { rotateMfaTrustEpoch } from "@/lib/auth/securityState";
import { admit, ADMISSION_POLICIES } from "@/lib/admission";
import { captureRouteError } from "@/lib/observability/captureRouteError";
import { readBoundedJson } from "@/lib/http/boundedJson";
import { authProviderFailureStatus } from "@/lib/auth/providerError";

const MAX_MFA_BODY_BYTES = 8_192;
const MAX_FACTOR_ID_CHARS = 1_024;

// ── DELETE /api/auth/mfa/unenroll ─────────────────────────────────────────────
// Removes an enrolled MFA factor and updates user_auth_settings accordingly.
//
// Body: { factorId: string }
// Response: { ok: true }
export async function DELETE(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError) {
    captureRouteError(new Error("MFA unenrollment auth backend unavailable"), {
      route: "auth/mfa/unenroll", operation: "authenticate", area: "auth",
      status: 503, code: "AUTH_BACKEND_UNAVAILABLE",
    });
    return NextResponse.json({ error: "AUTH_BACKEND_UNAVAILABLE" }, { status: 503 });
  }
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  const admission = await admit(user.id, ADMISSION_POLICIES.mfaChallenge);
  if (admission.kind === "unavailable") return NextResponse.json({ error: "ADMISSION_UNAVAILABLE" }, { status: 503 });
  if (admission.kind === "limited") return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429, headers: { "retry-after": String(admission.retryAfterSeconds) } });

  const parsedBody = await readBoundedJson(req, MAX_MFA_BODY_BYTES);
  if (!parsedBody.ok) return NextResponse.json({ error: parsedBody.code }, { status: parsedBody.status });
  const body = parsedBody.value as { factorId?: unknown } | null;

  if (
    !body
    || typeof body.factorId !== "string"
    || body.factorId.length === 0
    || body.factorId.length > MAX_FACTOR_ID_CHARS
  ) {
    return NextResponse.json({ error: "factorId is required" }, { status: 400 });
  }

  if (await rotateMfaTrustEpoch(supabase, "auth/mfa/unenroll") === null) return NextResponse.json({ error: "SECURITY_STATE_UNAVAILABLE" }, { status: 503 });
  let unenrollResult;
  try {
    unenrollResult = await supabase.auth.mfa.unenroll({
      factorId: body.factorId,
    });
  } catch {
    return redactRouteError(new Error("MFA unenrollment provider unavailable"), {
      route: "auth/mfa/unenroll", area: "auth", status: 503,
      code: "AUTH_BACKEND_UNAVAILABLE", message: "MFA unenrollment is temporarily unavailable",
    });
  }
  const { error } = unenrollResult;

  if (error) {
    const status = authProviderFailureStatus(error);
    return redactRouteError(new Error("MFA unenrollment provider failed"), {
      route: "auth/mfa/unenroll",
      area: "auth",
      status,
      code: status === 503 ? "AUTH_BACKEND_UNAVAILABLE" : "MFA_UNENROLLMENT_REJECTED",
      message: status === 503 ? "MFA unenrollment is temporarily unavailable" : "Failed to unenroll MFA factor",
    });
  }

  // After unenrolling, check whether any other verified factors remain.
  // If none remain we clear the 2FA flag; otherwise we leave it enabled.
  let factorsData;
  let factorsError: unknown;
  try {
    const factorsResult = await supabase.auth.mfa.listFactors();
    factorsData = factorsResult.data;
    factorsError = factorsResult.error;
  } catch {
    factorsData = null;
    factorsError = { code: "AUTH_BACKEND_UNAVAILABLE" };
  }
  if (factorsError || !factorsData) {
    captureRouteError(new Error("MFA factor projection unavailable after unenrollment"), {
      route: "auth/mfa/unenroll", operation: "project_factors", area: "auth",
      status: 503, code: "AUTH_PROJECTION_PENDING",
    });
    const response = NextResponse.json({ ok: true, settings_sync: "pending" });
    response.cookies.set(MFA_TRUST_COOKIE, "", {
      httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", maxAge: 0, path: "/",
    });
    return response;
  }
  const remainingVerified = (factorsData?.all ?? []).filter(
    (f: { id: string; status: string }) =>
      f.id !== body.factorId && f.status === "verified",
  );

  let settingsError: unknown = null;
  try {
    const settingsResult = await supabase.from("user_auth_settings").upsert(
      {
        user_id: user.id,
        twofa_enabled: remainingVerified.length > 0,
        twofa_method: remainingVerified.length > 0 ? undefined : null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );
    settingsError = settingsResult.error;
  } catch {
    settingsError = { code: "AUTH_SETTINGS_UNAVAILABLE" };
  }
  if (settingsError) {
    captureRouteError(new Error("MFA settings projection pending after unenrollment"), {
      route: "auth/mfa/unenroll", operation: "sync_settings", area: "auth",
      status: 503, code: "AUTH_PROJECTION_PENDING",
    });
  }

  // Changing the enrolled factors voids any remembered device: the trust token
  // was minted against a specific factor, so it must not survive that factor
  // being removed.
  const response = NextResponse.json({ ok: true, ...(settingsError ? { settings_sync: "pending" } : {}) });
  response.cookies.set(MFA_TRUST_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 0,
    path: "/",
  });
  return response;
}
