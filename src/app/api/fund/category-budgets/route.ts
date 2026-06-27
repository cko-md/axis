import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("fund_category_budgets")
    .select("*")
    .eq("user_id", user.id)
    .order("category");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ budgets: data ?? [] });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const category = String(body.category ?? "").trim();
  const monthlyLimit = Number(body.monthly_limit);
  if (!category || !Number.isFinite(monthlyLimit) || monthlyLimit < 0) {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("fund_category_budgets")
    .upsert(
      { user_id: user.id, category, monthly_limit: monthlyLimit, updated_at: new Date().toISOString() },
      { onConflict: "user_id,category" },
    )
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ budget: data });
}
