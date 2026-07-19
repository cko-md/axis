import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isPasswordPwned, PWNED_PASSWORD_MESSAGE } from "@/lib/auth/passwordCheck";
import { MFA_TRUST_COOKIE } from "@/lib/auth/mfaTrust";

// ── POST /api/auth/account ─────────────────────────────────────────────────────
// Handles email, password, and phone updates for the authenticated user.
//
// Body:
//   { action: 'change_email',    email: string }
//   { action: 'change_password', password: string }
//   { action: 'change_phone',    phone: string }
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  let body: { action?: unknown; email?: unknown; password?: unknown; phone?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { action } = body;

  // ── change_email ─────────────────────────────────────────────────────────────
  if (action === "change_email") {
    const email =
      typeof body.email === "string" ? body.email.trim().toLowerCase() : null;

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: "A valid email address is required" }, { status: 400 });
    }

    const { error } = await supabase.auth.updateUser({ email });
    if (error) {
      // Sanitize: don't leak internal Supabase error details
      console.error("[auth/account] change_email error:", error.message);
      return NextResponse.json(
        { error: "Unable to update email. Please try again." },
        { status: 400 },
      );
    }

    return NextResponse.json({
      ok: true,
      message: "Confirmation sent to new email.",
    });
  }

  // ── change_password ───────────────────────────────────────────────────────────
  if (action === "change_password") {
    const password = typeof body.password === "string" ? body.password : null;

    if (!password) {
      return NextResponse.json({ error: "A password is required" }, { status: 400 });
    }
    if (password.length < 8) {
      return NextResponse.json(
        { error: "Password must be at least 8 characters" },
        { status: 400 },
      );
    }
    if (await isPasswordPwned(password)) {
      return NextResponse.json({ error: PWNED_PASSWORD_MESSAGE }, { status: 400 });
    }

    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      console.error("[auth/account] change_password error:", error.message);
      return NextResponse.json(
        { error: "Unable to update password. Please try again." },
        { status: 400 },
      );
    }

    // A password change is the canonical "I may have been compromised" signal,
    // so every remembered device must stop skipping the second factor. This
    // does NOT clear on ordinary sign-out: surviving sign-out is the entire
    // point of remembering a device, and the token is useless without valid
    // credentials anyway.
    const passwordResponse = NextResponse.json({ ok: true });
    passwordResponse.cookies.set(MFA_TRUST_COOKIE, "", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 0,
      path: "/",
    });
    return passwordResponse;
  }

  // ── change_phone ──────────────────────────────────────────────────────────────
  if (action === "change_phone") {
    const phone = typeof body.phone === "string" ? body.phone.trim() : null;

    if (!phone) {
      return NextResponse.json({ error: "A phone number is required" }, { status: 400 });
    }

    const { error } = await supabase.auth.updateUser({ phone });
    if (error) {
      console.error("[auth/account] change_phone error:", error.message);
      return NextResponse.json(
        { error: "Unable to update phone number. Please try again." },
        { status: 400 },
      );
    }

    return NextResponse.json({ ok: true });
  }

  return NextResponse.json(
    { error: "action must be 'change_email', 'change_password', or 'change_phone'" },
    { status: 400 },
  );
}
