import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/database.types";
import { redactRouteError } from "@/lib/observability/redactRouteError";
import { readBoundedJsonBody } from "@/lib/http/readBoundedJsonBody";
import {
  minorUnitsToDecimalString,
  normalizeFinancialCurrency,
  scaledUnitsToDecimalString,
  strictExactMinorUnits,
  strictScaledUnits,
} from "@/lib/fund/financialTruth";

const MAX_MONEY = 1_000_000_000_000;
const KINDS = ["credit_card", "mortgage", "auto_loan", "student_loan", "personal_loan", "other"];
const PATCHABLE = new Set(["name", "kind", "balance", "apr", "minimum_payment", "due_date"]);

function parseMoney(value: unknown, field: string, currency: string, options?: { nullable?: boolean }) {
  if (options?.nullable && (value === null || value === "" || value === undefined)) return { value: null };
  const minor = strictExactMinorUnits(value, currency);
  const exact = minor === null ? null : minorUnitsToDecimalString(minor, currency);
  if (minor === null || minor < 0 || !exact || Number(exact) > MAX_MONEY) {
    return { error: `INVALID_${field.toUpperCase()}` };
  }
  return { value: exact as unknown as number };
}

function parseDueDate(value: unknown) {
  if (value === null || value === "" || value === undefined) return { value: null };
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return { value };
  return { error: "INVALID_DUE_DATE" };
}

function parseRate(value: unknown) {
  if (value === null || value === "" || value === undefined) return { value: null };
  const scaled = strictScaledUnits(value, 1_000_000);
  const exact = scaled === null ? null : scaledUnitsToDecimalString(scaled, 1_000_000);
  if (scaled === null || scaled < 0 || scaled > 100_000_000 || !exact) return { error: "INVALID_APR" };
  return { value: exact as unknown as number };
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const { data: existing, error: existingError } = await supabase
    .from("fund_liabilities")
    .select("currency, source")
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (existingError) return redactRouteError(existingError, { route: "fund/liabilities/[id]", area: "fund" });
  if (!existing) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  if (existing.source !== "manual") {
    return NextResponse.json({ error: "PROVIDER_LIABILITY_READ_ONLY" }, { status: 409 });
  }
  const parsedBody = await readBoundedJsonBody(request, 8_192);
  if (!parsedBody.ok) {
    return NextResponse.json({ error: parsedBody.error }, { status: parsedBody.status });
  }
  const body = parsedBody.value;
  const currency = normalizeFinancialCurrency(existing.currency, "");
  if (!currency) return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  if (Object.keys(body).some((key) => !PATCHABLE.has(key))) {
    return NextResponse.json({ error: "INVALID_FIELD" }, { status: 400 });
  }
  // A manual edit is a fresh manual observation, so refresh the retrieval anchor.
  const patch: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
    retrieved_at: new Date().toISOString(),
  };
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
    const balance = parseMoney(body.balance, "balance", currency);
    if (balance.error) return NextResponse.json({ error: balance.error }, { status: 400 });
    patch.balance = balance.value;
  }
  if ("apr" in body) {
    const apr = parseRate(body.apr);
    if (apr.error) return NextResponse.json({ error: apr.error }, { status: 400 });
    patch.apr = apr.value;
  }
  if ("minimum_payment" in body) {
    const minimumPayment = parseMoney(body.minimum_payment, "minimum_payment", currency, { nullable: true });
    if (minimumPayment.error) return NextResponse.json({ error: minimumPayment.error }, { status: 400 });
    patch.minimum_payment = minimumPayment.value;
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

  if (error) return redactRouteError(error, { route: "fund/liabilities/[id]", area: "fund" });
  return NextResponse.json({ liability: data });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const { error } = await supabase.from("fund_liabilities").delete().eq("id", id).eq("user_id", user.id);
  if (error) return redactRouteError(error, { route: "fund/liabilities/[id]", area: "fund" });
  return NextResponse.json({ ok: true });
}
