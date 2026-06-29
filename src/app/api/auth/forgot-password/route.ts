import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAppOrigin } from "@/lib/auth/getAppOrigin";
import { memoryRateLimit, redisRateLimit } from "@/lib/ratelimit";

const SUCCESS_RESPONSE = {
  ok: true,
  message: "If an account exists, a reset link has been sent.",
};

// ── POST /api/auth/forgot-password ─────────────────────────────────────────────
// Triggers a password-reset email. Always returns the same response to avoid
// leaking whether an email address is registered (no enumeration).
//
// If useRecovery=true the caller supplies a recovery email. Supabase only sends
// a reset if it matches a primary account address; for recovery-email lookups we
// call the same endpoint — if Supabase doesn't find it, nothing is sent, which
// is the correct privacy-preserving behaviour.
export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "anonymous";
  const { success } =
    (await redisRateLimit(ip, 5, "15 m", "axis:forgot-password")) ??
    memoryRateLimit(`forgot-password:${ip}`, 5, 15 * 60_000);
  if (!success) {
    return NextResponse.json(SUCCESS_RESPONSE); // opaque — don't reveal rate limiting
  }

  let body: { email?: unknown; useRecovery?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const email =
    typeof body.email === "string" ? body.email.trim().toLowerCase() : null;

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "A valid email is required" }, { status: 400 });
  }

  const redirectTo = `${getAppOrigin(req)}/auth/callback?type=recovery`;

  // We always call resetPasswordForEmail regardless of useRecovery. Supabase
  // only delivers the email when the address matches a real account, so there
  // is no information leak either way.
  const supabase = await createClient();
  await supabase.auth.resetPasswordForEmail(email, { redirectTo });

  // Always return the same opaque success message.
  return NextResponse.json(SUCCESS_RESPONSE);
}
