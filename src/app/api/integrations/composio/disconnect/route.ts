import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { deleteConnectedAccount } from "@/lib/integrations/composio";

// DELETE /api/integrations/composio/disconnect?toolkit=gmail|outlook
export async function DELETE(req: NextRequest) {
  const toolkit = req.nextUrl.searchParams.get("toolkit");
  if (!toolkit) return NextResponse.json({ error: "toolkit param is required" }, { status: 400 });

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  const { data: rows } = await supabase
    .from("composio_connections")
    .select("id, connected_account_id")
    .eq("user_id", user.id)
    .eq("toolkit", toolkit);

  await Promise.all(
    (rows ?? []).map((row) => deleteConnectedAccount(row.connected_account_id).catch(() => {})),
  );

  await supabase.from("composio_connections").delete().eq("user_id", user.id).eq("toolkit", toolkit);

  return NextResponse.json({ ok: true });
}
