import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { redactRouteError } from "@/lib/observability/redactRouteError";
import {
  minorUnitsToDecimalString,
  normalizeFinancialCurrency,
  strictExactMinorUnits,
} from "@/lib/fund/financialTruth";
import { readBoundedJsonBody } from "@/lib/http/readBoundedJsonBody";
import { minorUnitsFor } from "@/lib/fund/currency";

const MAX_MONTHLY_LIMIT_MAJOR = 100_000_000_000;

async function authenticate() {
  let supabase: Awaited<ReturnType<typeof createClient>>;
  try {
    supabase = await createClient();
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error) return { response: NextResponse.json({ error: "AUTH_UNAVAILABLE" }, { status: 503 }) };
    if (!user) return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
    return { supabase, user };
  } catch {
    return { response: NextResponse.json({ error: "AUTH_UNAVAILABLE" }, { status: 503 }) };
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate();
  if ("response" in auth) return auth.response;
  const { supabase, user } = auth;

  const { id } = await params;
  const parsedBody = await readBoundedJsonBody(request, 4_096);
  if (!parsedBody.ok) {
    return NextResponse.json({ error: parsedBody.error }, { status: parsedBody.status });
  }
  const body = parsedBody.value;
  const currency = normalizeFinancialCurrency(body.currency, "USD");
  const monthlyLimitMinor = currency ? strictExactMinorUnits(body.monthly_limit, currency) : null;
  const monthlyLimit = monthlyLimitMinor === null || !currency
    ? null
    : minorUnitsToDecimalString(monthlyLimitMinor, currency);
  if (
    !currency
    || monthlyLimit === null
    || monthlyLimitMinor === null
    || monthlyLimitMinor < 0
    || monthlyLimitMinor > MAX_MONTHLY_LIMIT_MAJOR * minorUnitsFor(currency)
  ) {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }

  let result;
  try {
    result = await supabase
      .from("fund_category_budgets")
      .update({
        monthly_limit: monthlyLimit as unknown as number,
        currency,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("user_id", user.id)
      .select()
      .single();
  } catch {
    return NextResponse.json({ error: "BUDGET_WRITE_UNAVAILABLE" }, { status: 503 });
  }

  if (result.error) return redactRouteError(result.error, { route: "fund/category-budgets/[id]", area: "fund" });
  return NextResponse.json({ budget: result.data }, { headers: { "cache-control": "private, no-store" } });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate();
  if ("response" in auth) return auth.response;
  const { supabase, user } = auth;

  const { id } = await params;
  let result;
  try {
    result = await supabase.from("fund_category_budgets").delete().eq("id", id).eq("user_id", user.id);
  } catch {
    return NextResponse.json({ error: "BUDGET_WRITE_UNAVAILABLE" }, { status: 503 });
  }
  const { error } = result;
  if (error) return redactRouteError(error, { route: "fund/category-budgets/[id]", area: "fund" });
  return NextResponse.json({ ok: true });
}
