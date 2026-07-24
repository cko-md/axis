import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAppOrigin } from "@/lib/auth/getAppOrigin";
import { admit, ADMISSION_POLICIES } from "@/lib/admission";
import { captureRouteError } from "@/lib/observability/captureRouteError";
import { readBoundedJson } from "@/lib/http/boundedJson";

const SUCCESS_RESPONSE = {
  ok: true,
  message: "If an account exists, a reset link has been sent.",
};
const MAX_REQUEST_BYTES = 4_096;
const MAX_EMAIL_CHARS = 320;

export async function POST(req: NextRequest) {
  const raw = await readBoundedJson(req, MAX_REQUEST_BYTES);
  if (!raw.ok) {
    return NextResponse.json(
      { error: raw.code },
      { status: raw.status },
    );
  }
  const body = raw.value as { email?: unknown } | null;
  const email =
    body && typeof body.email === "string"
      ? body.email.trim().toLowerCase()
      : null;
  if (
    !email
    || email.length > MAX_EMAIL_CHARS
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    return NextResponse.json(
      { error: "A valid email is required" },
      { status: 400 },
    );
  }

  const admission = await admit(`password-reset:${email}`, {
    ...ADMISSION_POLICIES.mfaChallenge,
    name: "forgot-password",
    limit: 5,
    window: "15 m",
    globalGuard: {
      name: "forgot-password-global",
      subject: "password-reset-global",
      limit: 300,
      window: "15 m",
    },
  });
  if (admission.kind === "unavailable") {
    return NextResponse.json(
      { error: "ADMISSION_UNAVAILABLE" },
      { status: 503 },
    );
  }
  if (admission.kind === "limited") {
    return NextResponse.json(SUCCESS_RESPONSE, {
      headers: { "retry-after": String(admission.retryAfterSeconds) },
    });
  }

  const redirectTo = `${getAppOrigin(req)}/auth/callback?type=recovery`;
  const supabase = await createClient();
  try {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo,
    });
    if (error) throw new Error("Password reset provider rejected request");
  } catch {
    captureRouteError(new Error("Password reset backend unavailable"), {
      route: "auth/forgot-password",
      operation: "request_reset",
      area: "auth",
      status: 503,
      code: "AUTH_BACKEND_UNAVAILABLE",
    });
    return NextResponse.json(
      {
        error: "AUTH_BACKEND_UNAVAILABLE",
        message: "Password reset is temporarily unavailable.",
      },
      { status: 503 },
    );
  }

  return NextResponse.json(SUCCESS_RESPONSE);
}
