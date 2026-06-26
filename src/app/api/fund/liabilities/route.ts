import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const KINDS = ["credit_card", "mortgage", "auto_loan", "student_loan", "personal_loan", "other"];

export async function GET() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("fund_liabilities")
    .select("*")
    .eq("user_id", user.id)
    .order("balance", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ liabilities: data ?? [] });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const name = String(body.name ?? "").trim();
  const kind = KINDS.includes(body.kind) ? body.kind : "credit_card";
  const balance = Number(body.balance);
  if (!name || !Number.isFinite(balance) || balance < 0) {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("fund_liabilities")
    .insert({
      user_id: user.id,
      name,
      kind,
      balance,
      apr: body.apr != null ? Number(body.apr) : null,
      minimum_payment: body.minimum_payment != null ? Number(body.minimum_payment) : null,
      due_date: body.due_date ?? null,
      source: "manual",
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ liability: data });
}
