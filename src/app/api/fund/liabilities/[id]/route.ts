import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/database.types";

const MAX_MONEY = 1_000_000_000_000;
const KINDS = ["credit_card", "mortgage", "auto_loan", "student_loan", "personal_loan", "other"];
const PATCHABLE = new Set(["name", "kind", "balance", "apr", "minimum_payment", "due_date"]);

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

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  if (Object.keys(body).some((key) => !PATCHABLE.has(key))) {
    return NextResponse.json({ error: "INVALID_FIELD" }, { status: 400 });
  }
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if ("name" in body) {
    const name = String(body.name ?? "").trim();
    if (!name) return NextResponse.json({ error: "INVALID_NAME" }, { status: 400 });
    patch.name = name;
  }
  if ("kind" in body) {
    if (!KINDS.includes(String(body.kind))) return NextResponse.json({ error: "INVALID_KIND" }, { status: 400 });
    patch.kind = body.kind;
  }
  if ("balance" in body) {
    const balance = parseMoney(body.balance, "balance");
    if (balance.error) return NextResponse.json({ error: balance.error }, { status: 400 });
    patch.balance = balance.value;
  }
  for (const key of ["apr", "minimum_payment"] as const) {
    if (key in body) {
      const parsed = parseMoney(body[key], key, { nullable: true });
      if (parsed.error) return NextResponse.json({ error: parsed.error }, { status: 400 });
      patch[key] = parsed.value;
    }
  }
  if ("due_date" in body) {
    const dueDate = parseDueDate(body.due_date);
    if (dueDate.error) return NextResponse.json({ error: dueDate.error }, { status: 400 });
    patch.due_date = dueDate.value;
  }

  const { data, error } = await supabase
    .from("fund_liabilities")
    .update(patch as Database["public"]["Tables"]["fund_liabilities"]["Update"])
    .eq("id", id)
    .eq("user_id", user.id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ liability: data });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const { error } = await supabase.from("fund_liabilities").delete().eq("id", id).eq("user_id", user.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
