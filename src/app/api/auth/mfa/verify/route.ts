import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { memoryRateLimit, redisRateLimit } from "@/lib/ratelimit";
import { redactRouteError } from "@/lib/observability/redactRouteError";

// ── POST /api/auth/mfa/verify ──────────────────────────────────────────────────
// Verifies an MFA challenge code. On success the factor is confirmed and
// user_auth_settings is updated to reflect 2FA being enabled.
//
// Body: { factorId: string, challengeId: string, code: string }
// Response: { verified: true, session: Session | null }
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  // A 6-digit TOTP code has only 1,000,000 possibilities — throttle attempts
  // per user so it can't be brute-forced within the code's validity window.
  const { success } =
    (await redisRateLimit(user.id, 5, "5 m", "axis:mfa-verify")) ??
    memoryRateLimit(`mfa-verify:${user.id}`, 5, 5 * 60_000);
  if (!success) {
    return NextResponse.json({ error: "Too many attempts. Please wait before trying again." }, { status: 429 });
  }

  let body: { factorId?: unknown; challengeId?: unknown; code?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { factorId, challengeId, code } = body;

  if (!factorId || typeof factorId !== "string") {
    return NextResponse.json({ error: "factorId is required" }, { status: 400 });
  }
  if (!challengeId || typeof challengeId !== "string") {
    return NextResponse.json({ error: "challengeId is required" }, { status: 400 });
  }
  if (!code || typeof code !== "string") {
    return NextResponse.json({ error: "code is required" }, { status: 400 });
  }

  const { error } = await supabase.auth.mfa.verify({
    factorId,
    challengeId,
    code,
  });

  if (error) {
    return redactRouteError(error, {
      route: "auth/mfa/verify",
      area: "auth",
      status: 400,
      message: "MFA verification failed",
    });
  }

  // Determine the factor type from the enrolled factors list and persist the
  // 2FA status so the settings UI reflects the change immediately.
  const { data: factorsData } = await supabase.auth.mfa.listFactors();
  const factor = factorsData?.all?.find(
    (f: { id: string; factor_type: string }) => f.id === factorId,
  );
  const twofaMethod: "totp" | "sms" | "email" =
    factor?.factor_type === "phone" ? "sms" : "totp";

  await supabase.from("user_auth_settings").upsert(
    {
      user_id: user.id,
      twofa_enabled: true,
      twofa_method: twofaMethod,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );

  return NextResponse.json({ verified: true });
}
