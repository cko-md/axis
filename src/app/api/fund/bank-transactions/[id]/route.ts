import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const PATCHABLE = [
  "custom_category",
  "tags",
  "is_transfer",
  "excluded_from_budget",
  "reviewed",
  "notes",
  "amount",
] as const;

/** PATCH /api/fund/bank-transactions/:id — categorize, tag, exclude, mark reviewed. */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const patch: Record<string, unknown> = {};
  for (const key of PATCHABLE) {
    if (key in body) patch[key] = body[key];
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "NO_VALID_FIELDS" }, { status: 400 });
  }
  patch.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from("fund_bank_transactions")
    .update(patch)
    .eq("id", id)
    .eq("user_id", user.id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ transaction: data });
}
