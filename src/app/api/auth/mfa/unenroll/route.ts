import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { redactRouteError } from "@/lib/observability/redactRouteError";

// ── DELETE /api/auth/mfa/unenroll ─────────────────────────────────────────────
// Removes an enrolled MFA factor and updates user_auth_settings accordingly.
//
// Body: { factorId: string }
// Response: { ok: true }
export async function DELETE(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  let body: { factorId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.factorId || typeof body.factorId !== "string") {
    return NextResponse.json({ error: "factorId is required" }, { status: 400 });
  }

  const { error } = await supabase.auth.mfa.unenroll({
    factorId: body.factorId,
  });

  if (error) {
    return redactRouteError(error, {
      route: "auth/mfa/unenroll",
      area: "auth",
      status: 400,
      message: "Failed to unenroll MFA factor",
    });
  }

  // After unenrolling, check whether any other verified factors remain.
  // If none remain we clear the 2FA flag; otherwise we leave it enabled.
  const { data: factorsData } = await supabase.auth.mfa.listFactors();
  const remainingVerified = (factorsData?.all ?? []).filter(
    (f: { id: string; status: string }) =>
      f.id !== body.factorId && f.status === "verified",
  );

  await supabase.from("user_auth_settings").upsert(
    {
      user_id: user.id,
      twofa_enabled: remainingVerified.length > 0,
      twofa_method: remainingVerified.length > 0 ? undefined : null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );

  return NextResponse.json({ ok: true });
}
