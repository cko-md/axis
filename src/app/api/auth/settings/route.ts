import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// ── GET /api/auth/settings ─────────────────────────────────────────────────────
// Returns the current user's auth settings + MFA factors.
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  const [settingsResult, factorsResult] = await Promise.all([
    supabase
      .from("user_auth_settings")
      .select(
        "passkey_enabled, biometric_prompted, twofa_enabled, twofa_method, recovery_email, remember_me",
      )
      .eq("user_id", user.id)
      .single(),
    supabase.auth.mfa.listFactors(),
  ]);

  const defaults = {
    passkey_enabled: false,
    biometric_prompted: false,
    twofa_enabled: false,
    twofa_method: null,
    recovery_email: null,
    remember_me: false,
  };

  const settings =
    settingsResult.error || !settingsResult.data ? defaults : settingsResult.data;

  const mfaFactors = (factorsResult.data?.all ?? []).map(
    (f: { id: string; factor_type: string; status: string }) => ({
      id: f.id,
      type: f.factor_type,
      status: f.status,
    }),
  );

  return NextResponse.json({ ...settings, mfa_factors: mfaFactors });
}

// ── POST /api/auth/settings ────────────────────────────────────────────────────
// Upserts a partial set of auth settings for the current user.
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const allowed: Record<string, unknown> = {};
  const errors: string[] = [];

  if ("biometric_prompted" in body) {
    if (typeof body.biometric_prompted !== "boolean") {
      errors.push("biometric_prompted must be a boolean");
    } else {
      allowed.biometric_prompted = body.biometric_prompted;
    }
  }

  if ("remember_me" in body) {
    if (typeof body.remember_me !== "boolean") {
      errors.push("remember_me must be a boolean");
    } else {
      allowed.remember_me = body.remember_me;
    }
  }

  if ("recovery_email" in body) {
    if (body.recovery_email !== null && typeof body.recovery_email !== "string") {
      errors.push("recovery_email must be a string or null");
    } else if (
      typeof body.recovery_email === "string" &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.recovery_email)
    ) {
      errors.push("recovery_email must be a valid email address");
    } else {
      allowed.recovery_email = body.recovery_email;
    }
  }

  if ("twofa_enabled" in body) {
    if (typeof body.twofa_enabled !== "boolean") {
      errors.push("twofa_enabled must be a boolean");
    } else {
      allowed.twofa_enabled = body.twofa_enabled;
    }
  }

  if ("twofa_method" in body) {
    if (
      body.twofa_method !== null &&
      !["totp", "sms", "email"].includes(body.twofa_method as string)
    ) {
      errors.push("twofa_method must be 'totp', 'sms', 'email', or null");
    } else {
      allowed.twofa_method = body.twofa_method;
    }
  }

  if (errors.length > 0) {
    return NextResponse.json({ error: errors.join("; ") }, { status: 400 });
  }

  if (Object.keys(allowed).length === 0) {
    return NextResponse.json({ error: "No valid fields provided" }, { status: 400 });
  }

  const { error } = await supabase.from("user_auth_settings").upsert(
    { user_id: user.id, ...allowed, updated_at: new Date().toISOString() },
    { onConflict: "user_id" },
  );

  if (error) {
    console.error("[auth/settings] upsert error:", error.message);
    return NextResponse.json({ error: "Failed to save settings" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
