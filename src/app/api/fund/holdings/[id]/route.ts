import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { fundApiFailure } from "@/lib/fund/apiError";

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const { error } = await supabase.from("fund_holdings").delete().eq("id", id).eq("user_id", user.id);
  if (error) return fundApiFailure(error, "/api/fund/holdings/:id", "delete_holding");
  return NextResponse.json({ ok: true });
}
