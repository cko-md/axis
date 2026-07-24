import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isPasswordPwned, PWNED_PASSWORD_MESSAGE } from "@/lib/auth/passwordCheck";
import { MFA_TRUST_COOKIE } from "@/lib/auth/mfaTrust";
import { rotateMfaTrustEpoch } from "@/lib/auth/securityState";
import { admit, ADMISSION_POLICIES } from "@/lib/admission";
import { captureRouteError } from "@/lib/observability/captureRouteError";
import { readBoundedJson } from "@/lib/http/boundedJson";
import { authProviderFailureStatus } from "@/lib/auth/providerError";

const MAX_ACCOUNT_BODY_BYTES = 16_384;
const MAX_EMAIL_CHARS = 320;
const MAX_PASSWORD_CHARS = 1_024;
const MAX_PHONE_CHARS = 64;

function accountUpdateFailure(error: unknown, operation: string) {
  const status = authProviderFailureStatus(error);
  captureRouteError(new Error("Account provider update failed"), {
    route: "auth/account",
    operation,
    area: "auth",
    status,
    code:
      status === 503
        ? "AUTH_BACKEND_UNAVAILABLE"
        : "ACCOUNT_UPDATE_REJECTED",
  });
  return NextResponse.json(
    {
      error:
        status === 503
          ? "AUTH_BACKEND_UNAVAILABLE"
          : "Account update was rejected.",
    },
    { status },
  );
}

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError) {
    captureRouteError(new Error("Account authentication backend unavailable"), {
      route: "auth/account",
      operation: "authenticate",
      area: "auth",
      status: 503,
      code: "AUTH_BACKEND_UNAVAILABLE",
    });
    return NextResponse.json(
      { error: "AUTH_BACKEND_UNAVAILABLE" },
      { status: 503 },
    );
  }
  if (!user) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  const admission = await admit(user.id, ADMISSION_POLICIES.mfaVerify);
  if (admission.kind === "unavailable") {
    return NextResponse.json(
      { error: "ADMISSION_UNAVAILABLE" },
      { status: 503 },
    );
  }
  if (admission.kind === "limited") {
    return NextResponse.json(
      { error: "RATE_LIMITED" },
      {
        status: 429,
        headers: { "retry-after": String(admission.retryAfterSeconds) },
      },
    );
  }

  const parsedBody = await readBoundedJson(req, MAX_ACCOUNT_BODY_BYTES);
  if (!parsedBody.ok) {
    return NextResponse.json(
      { error: parsedBody.code },
      { status: parsedBody.status },
    );
  }
  const body = parsedBody.value as {
    action?: unknown;
    email?: unknown;
    password?: unknown;
    phone?: unknown;
  } | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "INVALID_JSON" }, { status: 400 });
  }

  const { action } = body;
  if (action === "change_email") {
    const email =
      typeof body.email === "string"
        ? body.email.trim().toLowerCase()
        : null;
    if (
      !email
      || email.length > MAX_EMAIL_CHARS
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ) {
      return NextResponse.json(
        { error: "A valid email address is required" },
        { status: 400 },
      );
    }
    if (await rotateMfaTrustEpoch(supabase, "auth/account") === null) {
      return NextResponse.json(
        { error: "SECURITY_STATE_UNAVAILABLE" },
        { status: 503 },
      );
    }

    let updateResult;
    try {
      updateResult = await supabase.auth.updateUser({ email });
    } catch {
      return accountUpdateFailure(
        { code: "NETWORK_UNAVAILABLE" },
        "change_email",
      );
    }
    if (updateResult.error) {
      return accountUpdateFailure(updateResult.error, "change_email");
    }
    return NextResponse.json({
      ok: true,
      message: "Confirmation sent to new email.",
    });
  }

  if (action === "change_password") {
    const password =
      typeof body.password === "string" ? body.password : null;
    if (!password || password.length > MAX_PASSWORD_CHARS) {
      return NextResponse.json(
        { error: "A password is required" },
        { status: 400 },
      );
    }
    if (password.length < 8) {
      return NextResponse.json(
        { error: "Password must be at least 8 characters" },
        { status: 400 },
      );
    }

    let passwordPwned: boolean;
    try {
      passwordPwned = await isPasswordPwned(password);
    } catch {
      captureRouteError(new Error("Password compromise check unavailable"), {
        route: "auth/account",
        operation: "check_password",
        area: "auth",
        status: 503,
        code: "PASSWORD_CHECK_UNAVAILABLE",
      });
      return NextResponse.json(
        { error: "PASSWORD_CHECK_UNAVAILABLE" },
        { status: 503 },
      );
    }
    if (passwordPwned) {
      return NextResponse.json(
        { error: PWNED_PASSWORD_MESSAGE },
        { status: 400 },
      );
    }
    if (await rotateMfaTrustEpoch(supabase, "auth/account") === null) {
      return NextResponse.json(
        { error: "SECURITY_STATE_UNAVAILABLE" },
        { status: 503 },
      );
    }

    let updateResult;
    try {
      updateResult = await supabase.auth.updateUser({ password });
    } catch {
      return accountUpdateFailure(
        { code: "NETWORK_UNAVAILABLE" },
        "change_password",
      );
    }
    if (updateResult.error) {
      return accountUpdateFailure(updateResult.error, "change_password");
    }

    const response = NextResponse.json({ ok: true });
    response.cookies.set(MFA_TRUST_COOKIE, "", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 0,
      path: "/",
    });
    return response;
  }

  if (action === "change_phone") {
    const phone =
      typeof body.phone === "string" ? body.phone.trim() : null;
    if (!phone || phone.length > MAX_PHONE_CHARS) {
      return NextResponse.json(
        { error: "A phone number is required" },
        { status: 400 },
      );
    }
    if (await rotateMfaTrustEpoch(supabase, "auth/account") === null) {
      return NextResponse.json(
        { error: "SECURITY_STATE_UNAVAILABLE" },
        { status: 503 },
      );
    }

    let updateResult;
    try {
      updateResult = await supabase.auth.updateUser({ phone });
    } catch {
      return accountUpdateFailure(
        { code: "NETWORK_UNAVAILABLE" },
        "change_phone",
      );
    }
    if (updateResult.error) {
      return accountUpdateFailure(updateResult.error, "change_phone");
    }
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json(
    {
      error:
        "action must be 'change_email', 'change_password', or 'change_phone'",
    },
    { status: 400 },
  );
}
