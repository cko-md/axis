import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { admit, ADMISSION_POLICIES } from "@/lib/admission";
import { rotateMfaTrustEpoch } from "@/lib/auth/securityState";
import { captureRouteError } from "@/lib/observability/captureRouteError";
import { readBoundedJson } from "@/lib/http/boundedJson";
import { authProviderFailureStatus } from "@/lib/auth/providerError";
import { redactRouteError } from "@/lib/observability/redactRouteError";

const MAX_MFA_BODY_BYTES = 8_192;
const MAX_PHONE_CHARS = 64;
const MAX_FRIENDLY_NAME_CHARS = 100;

// ── POST /api/auth/mfa/enroll ──────────────────────────────────────────────────
// Enrolls a new MFA factor for the authenticated user.
//
// Body:
//   { method: 'totp' | 'phone', phone?: string, friendlyName?: string }
//
// TOTP response:
//   { id, type: 'totp', totp: { qrCode, secret, uri } }
//
// Phone response:
//   { id, type: 'phone' }
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError) {
    captureRouteError(new Error("MFA enrollment auth backend unavailable"), {
      route: "auth/mfa/enroll", operation: "authenticate", area: "auth",
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
  const body = parsedBody.value as { method?: unknown; phone?: unknown; friendlyName?: unknown } | null;
  if (!body || typeof body !== "object") return NextResponse.json({ error: "INVALID_JSON" }, { status: 400 });

  const { method, phone, friendlyName } = body;

  if (method !== "totp" && method !== "phone") {
    return NextResponse.json(
      { error: "method must be 'totp' or 'phone'" },
      { status: 400 },
    );
  }
  if (
    friendlyName !== undefined
    && (typeof friendlyName !== "string" || friendlyName.length > MAX_FRIENDLY_NAME_CHARS)
  ) {
    return NextResponse.json({ error: "Invalid friendly name" }, { status: 400 });
  }
  if (
    phone !== undefined
    && (typeof phone !== "string" || phone.length > MAX_PHONE_CHARS)
  ) {
    return NextResponse.json({ error: "Invalid phone number" }, { status: 400 });
  }
  if (await rotateMfaTrustEpoch(supabase, "auth/mfa/enroll") === null) return NextResponse.json({ error: "SECURITY_STATE_UNAVAILABLE" }, { status: 503 });

  if (method === "totp") {
    let enrollResult;
    try {
      enrollResult = await supabase.auth.mfa.enroll({
        factorType: "totp",
        friendlyName:
          typeof friendlyName === "string" && friendlyName.trim()
            ? friendlyName.trim()
            : "Authenticator App",
      });
    } catch {
      return redactRouteError(new Error("MFA enrollment provider unavailable"), {
        route: "auth/mfa/enroll", area: "auth", status: 503,
        code: "AUTH_BACKEND_UNAVAILABLE", message: "MFA enrollment is temporarily unavailable",
      });
    }
    const { data, error } = enrollResult;

    if (error || !data) {
      const status = error ? authProviderFailureStatus(error) : 503;
      return redactRouteError(new Error("MFA enrollment provider failed"), {
        route: "auth/mfa/enroll", area: "auth", status,
        code: status === 503 ? "AUTH_BACKEND_UNAVAILABLE" : "MFA_ENROLLMENT_REJECTED",
        message: status === 503 ? "MFA enrollment is temporarily unavailable" : "MFA enrollment was rejected",
      });
    }

    return NextResponse.json({
      id: data.id,
      type: "totp",
      totp: {
        qrCode: data.totp.qr_code,
        secret: data.totp.secret,
        uri: data.totp.uri,
      },
    });
  }

  // method === 'phone'
  if (!phone || typeof phone !== "string") {
    return NextResponse.json(
      { error: "phone is required for phone-based MFA" },
      { status: 400 },
    );
  }

  let enrollResult;
  try {
    enrollResult = await supabase.auth.mfa.enroll({
      factorType: "phone",
      phone: phone.trim(),
    });
  } catch {
    return redactRouteError(new Error("MFA enrollment provider unavailable"), {
      route: "auth/mfa/enroll", area: "auth", status: 503,
      code: "AUTH_BACKEND_UNAVAILABLE", message: "MFA enrollment is temporarily unavailable",
    });
  }
  const { data, error } = enrollResult;

  if (error || !data) {
    const status = error ? authProviderFailureStatus(error) : 503;
    return redactRouteError(new Error("MFA enrollment provider failed"), {
      route: "auth/mfa/enroll", area: "auth", status,
      code: status === 503 ? "AUTH_BACKEND_UNAVAILABLE" : "MFA_ENROLLMENT_REJECTED",
      message: status === 503 ? "MFA enrollment is temporarily unavailable" : "MFA enrollment was rejected",
    });
  }

  return NextResponse.json({ id: data.id, type: "phone" });
}
