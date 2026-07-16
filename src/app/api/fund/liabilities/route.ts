import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { fundApiFailure } from "@/lib/fund/apiError";

const KINDS = ["credit_card", "mortgage", "auto_loan", "student_loan", "personal_loan", "other"];
const MAX_MONEY = 1_000_000_000_000;

function parseMoney(value: unknown, field: string, options?: { nullable?: boolean }) {
  if (options?.nullable && (value === null || value === "" || value === undefined)) return { value: null };
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_MONEY) return { error: `INVALID_${field.toUpperCase()}` };
  return { value: parsed };
}

function parseDueDate(value: unknown) {
  if (value === null || value === "" || value === undefined) return { value: null };
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return { value };
  return { error: "INVALID_DUE_DATE" };
}

export async function GET() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("fund_liabilities")
    .select("*")
    .eq("user_id", user.id)
    .order("balance", { ascending: false });

  if (error) return fundApiFailure(error, "/api/fund/liabilities", "list_liabilities");
  return NextResponse.json({ liabilities: data ?? [] });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const name = String(body.name ?? "").trim();
  const kind = KINDS.includes(body.kind) ? body.kind : "credit_card";
  const balance = parseMoney(body.balance, "balance");
  const apr = parseMoney(body.apr, "apr", { nullable: true });
  const minimumPayment = parseMoney(body.minimum_payment, "minimum_payment", { nullable: true });
  const dueDate = parseDueDate(body.due_date);
  const firstError = balance.error ?? apr.error ?? minimumPayment.error ?? dueDate.error;
  if (!name || firstError) {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("fund_liabilities")
    .insert({
      user_id: user.id,
      name,
      kind,
      balance: balance.value as number, // validated non-null above (balance.error → 400)
      apr: apr.value,
      minimum_payment: minimumPayment.value,
      due_date: dueDate.value,
      source: "manual",
      // Provenance: for a manual entry, entry time IS the retrieval time.
      provider: "manual",
      retrieved_at: new Date().toISOString(),
      currency: "USD",
    })
    .select()
    .single();

  if (error) return fundApiFailure(error, "/api/fund/liabilities", "create_liability");
  return NextResponse.json({ liability: data });
}
