import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { authApiFailure } from "@/lib/auth/apiError";

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
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  let body: { method?: unknown; phone?: unknown; friendlyName?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { method, phone, friendlyName } = body;

  if (method !== "totp" && method !== "phone") {
    return NextResponse.json(
      { error: "method must be 'totp' or 'phone'" },
      { status: 400 },
    );
  }

  if (method === "totp") {
    const { data, error } = await supabase.auth.mfa.enroll({
      factorType: "totp",
      friendlyName:
        typeof friendlyName === "string" && friendlyName.trim()
          ? friendlyName.trim()
          : "Authenticator App",
    });

    if (error || !data) {
      return authApiFailure(error ?? new Error("TOTP enrollment failed"), "/api/auth/mfa/enroll", "enroll_totp", 400);
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

  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: "phone",
    phone: phone.trim(),
  });

  if (error || !data) {
    return authApiFailure(error ?? new Error("Phone enrollment failed"), "/api/auth/mfa/enroll", "enroll_phone", 400);
  }

  return NextResponse.json({ id: data.id, type: "phone" });
}
