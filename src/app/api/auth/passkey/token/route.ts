import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { encrypt } from "@/lib/crypto";

// ── POST — store an encrypted refresh token against passkey(s) ───────────────

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  let body: { refresh_token: string; credential_id?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { refresh_token, credential_id } = body;
  if (!refresh_token || typeof refresh_token !== "string") {
    return NextResponse.json({ error: "refresh_token is required" }, { status: 400 });
  }

  const encrypted = encrypt(refresh_token);
  if (!encrypted) {
    return NextResponse.json({ error: "Encryption unavailable" }, { status: 500 });
  }

  let query = supabase
    .from("user_passkeys")
    .update({ refresh_token_enc: encrypted })
    .eq("user_id", user.id)
    .select("id");

  if (credential_id) {
    query = query.eq("credential_id", credential_id);
  }

  const { data: updated, error } = await query;
  if (error) {
    return NextResponse.json({ error: "Could not store passkey session material" }, { status: 500 });
  }
  if (!updated || updated.length === 0) {
    return NextResponse.json({ error: "Passkey not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
