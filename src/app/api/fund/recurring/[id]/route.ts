import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { fundApiFailure } from "@/lib/fund/apiError";

const VALID_STATUS = ["active", "cancelled", "irregular"];

/** PATCH /api/fund/recurring/:id — confirm or cancel a detected recurring charge. */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  if (!VALID_STATUS.includes(body.status)) {
    return NextResponse.json({ error: "INVALID_STATUS" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("fund_recurring_transactions")
    .update({ status: body.status, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", user.id)
    .select()
    .single();

  if (error) return fundApiFailure(error, "/api/fund/recurring/:id", "update_recurring");
  return NextResponse.json({ recurring: data });
}
