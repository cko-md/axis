import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// ── DELETE — remove a passkey for the current user ───────────────────────────

export async function DELETE(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  let body: { passkeyId: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { passkeyId } = body;
  if (!passkeyId || typeof passkeyId !== "string") {
    return NextResponse.json({ error: "passkeyId is required" }, { status: 400 });
  }

  // Delete the specified passkey, scoped to the current user for safety
  const { error: deleteError } = await supabase
    .from("user_passkeys")
    .delete()
    .eq("id", passkeyId)
    .eq("user_id", user.id);

  if (deleteError) {
    return NextResponse.json({ error: deleteError.message }, { status: 500 });
  }

  // Check if any passkeys remain; if not, mark passkey_enabled=false
  const { count } = await supabase
    .from("user_passkeys")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id);

  if (count === 0) {
    await supabase.from("user_auth_settings").upsert(
      {
        user_id: user.id,
        passkey_enabled: false,
      },
      { onConflict: "user_id" },
    );
  }

  return NextResponse.json({ ok: true });
}
