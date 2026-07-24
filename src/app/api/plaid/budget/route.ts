import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { captureRouteError } from "@/lib/observability/captureRouteError";
import {
  readCompleteTransactionRows,
  TRANSACTION_HISTORY_DAYS,
} from "@/lib/fund/transactionCoverage";
import {
  addMinorUnits,
  minorUnitsToDecimalString,
  strictExactMinorUnits,
} from "@/lib/fund/financialTruth";

const CATEGORY_LABELS: Record<string, string> = {
  FOOD_AND_DRINK: "Dining",
  GENERAL_MERCHANDISE: "Shopping",
  GROCERIES: "Groceries",
  TRANSPORTATION: "Transport",
  MEDICAL: "Medical",
  ENTERTAINMENT: "Entertainment",
  PERSONAL_CARE: "Personal Care",
  SUBSCRIPTION: "Subscriptions",
  RENT_AND_UTILITIES: "Housing",
  TRAVEL: "Travel",
  OTHER: "Other",
};

type BudgetTransaction = {
  connection_id: string;
  generation_id: string;
  amount: unknown;
  iso_currency_code: string;
  custom_category: string | null;
  plaid_category: string | null;
  excluded_from_budget: boolean;
  pending: boolean;
  posted_date: string;
};

function money(minor: number, currency: string): string {
  const decimal = minorUnitsToDecimalString(minor, currency);
  if (decimal === null) return "—";
  return currency === "USD" ? `$${decimal}` : `${currency} ${decimal}`;
}

function roundedPercent(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Number(
    (BigInt(numerator) * BigInt(100) + BigInt(denominator) / BigInt(2))
      / BigInt(denominator),
  );
}

/** Complete persisted spending joined only to user-authored budget targets. */
export async function POST() {
  let supabase: Awaited<ReturnType<typeof createClient>>;
  try { supabase = await createClient(); } catch {
    return NextResponse.json({ error: "AUTH_UNAVAILABLE" }, { status: 503 });
  }
  let authResult: Awaited<ReturnType<typeof supabase.auth.getUser>>;
  try { authResult = await supabase.auth.getUser(); } catch {
    return NextResponse.json({ error: "AUTH_UNAVAILABLE" }, { status: 503 });
  }
  const { data: { user }, error: authError } = authResult;
  if (authError) {
    captureRouteError(new Error("Plaid budget authentication unavailable"), {
      route: "/api/plaid/budget",
      operation: "authenticate",
      area: "fund",
      provider: "supabase",
      status: 503,
      code: "AUTH_BACKEND_UNAVAILABLE",
    });
    return NextResponse.json({ error: "AUTH_UNAVAILABLE" }, { status: 503 });
  }
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const today = new Date().toISOString().slice(0, 10);
  const coverageStart = new Date(Date.now() - TRANSACTION_HISTORY_DAYS * 86_400_000)
    .toISOString().slice(0, 10);
  const monthStart = `${today.slice(0, 8)}01`;
  const [complete, budgetResult] = await Promise.all([
    readCompleteTransactionRows<BudgetTransaction>(
      supabase,
      user.id,
      coverageStart,
      today,
      "connection_id, generation_id, amount, iso_currency_code, custom_category, plaid_category, excluded_from_budget, pending, posted_date",
    ),
    supabase
      .from("fund_category_budgets")
      .select("category, monthly_limit, currency")
      .eq("user_id", user.id)
      .order("category", { ascending: true }),
  ]);
  if (!complete || budgetResult.error) {
    if (budgetResult.error) {
      captureRouteError(new Error("Fund budget query unavailable"), {
        route: "/api/plaid/budget",
        operation: "read_persisted_budgets",
        area: "fund",
        provider: "supabase",
        status: 503,
      });
    }
    return NextResponse.json(
      { configured: true, completeness: "unavailable", error: "BUDGET_DATA_UNAVAILABLE" },
      { status: 503 },
    );
  }

  const spending = new Map<string, number>();
  for (const transaction of complete.rows) {
    if (
      transaction.posted_date < monthStart
      || transaction.posted_date > today
      || transaction.pending
      || transaction.excluded_from_budget
    ) continue;
    const amountMinor = strictExactMinorUnits(transaction.amount, transaction.iso_currency_code);
    if (amountMinor === null) {
      return NextResponse.json(
        { configured: true, completeness: "unavailable", error: "BUDGET_AMOUNT_UNAVAILABLE" },
        { status: 503 },
      );
    }
    if (amountMinor >= 0) continue;
    const rawCategory = transaction.custom_category ?? transaction.plaid_category ?? "OTHER";
    const category = CATEGORY_LABELS[rawCategory] ?? rawCategory;
    const key = `${category}\u0000${transaction.iso_currency_code}`;
    const total = addMinorUnits(spending.get(key) ?? 0, -amountMinor);
    if (total === null) {
      return NextResponse.json(
        { configured: true, completeness: "unavailable", error: "BUDGET_AMOUNT_UNAVAILABLE" },
        { status: 503 },
      );
    }
    spending.set(key, total);
  }

  const budgets = [];
  for (const target of budgetResult.data ?? []) {
    const limitMinor = strictExactMinorUnits(target.monthly_limit, target.currency);
    if (limitMinor === null || limitMinor < 0) {
      return NextResponse.json(
        { configured: true, completeness: "unavailable", error: "BUDGET_TARGET_INVALID" },
        { status: 503 },
      );
    }
    if (limitMinor === 0) continue;
    const label = CATEGORY_LABELS[target.category] ?? target.category;
    const spentMinor = spending.get(`${label}\u0000${target.currency}`) ?? 0;
    const pct = Math.min(roundedPercent(spentMinor, limitMinor), 120);
    budgets.push({
      label,
      spent: `${money(spentMinor, target.currency)} / ${money(limitMinor, target.currency)}`,
      spentMinor,
      budgetMinor: limitMinor,
      currency: target.currency,
      pct,
      cls: pct >= 100 ? "over" : pct >= 80 ? "" : "good",
    });
  }

  const over = budgets.find((budget) => budget.pct >= 100);
  const insights: Array<{
    ic: string;
    icColor?: string;
    title: string;
    meta: string;
    value: string;
    up: boolean;
  }> = over
    ? [{
        ic: "↗",
        icColor: "var(--down)",
        title: `${over.label} is over its saved budget`,
        meta: `${money(over.spentMinor, over.currency)} vs ${money(over.budgetMinor, over.currency)} target this month`,
        value: `−${money(over.spentMinor - over.budgetMinor, over.currency)}`,
        up: false,
      }]
    : [];
  const totalsByCurrency = new Map<string, number>();
  for (const [key, amount] of spending) {
    const currency = key.split("\u0000")[1];
    const total = addMinorUnits(totalsByCurrency.get(currency) ?? 0, amount);
    if (total === null) {
      return NextResponse.json(
        { configured: true, completeness: "unavailable", error: "BUDGET_AMOUNT_UNAVAILABLE" },
        { status: 503 },
      );
    }
    totalsByCurrency.set(currency, total);
  }
  for (const [currency, total] of [...totalsByCurrency].sort(([left], [right]) => left.localeCompare(right))) {
    insights.push({
      ic: "📊",
      title: `${money(total, currency)} complete spending this month`,
      meta: `${currency} spending is kept separate; no implicit FX conversion`,
      value: money(total, currency),
      up: false,
    });
  }

  return NextResponse.json({
    configured: true,
    completeness: "complete",
    budgets,
    insights,
  });
}
