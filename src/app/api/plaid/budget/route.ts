import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getPlaidCreds, plaidHost } from "../_lib";
import { getPlaidAccessToken } from "@/lib/fund/plaidTokens";

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

const CATEGORY_BUDGETS: Record<string, number> = {
  "Dining": 525,
  "Groceries": 450,
  "Subscriptions": 120,
  "Transport": 200,
  "Medical": 300,
  "Entertainment": 150,
  "Other": 200,
};

export async function POST() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const creds = getPlaidCreds();
  if (!creds) {
    return NextResponse.json({ configured: false, budgets: [], insights: [] });
  }

  const accessToken = await getPlaidAccessToken(user.id);

  if (!accessToken) {
    return NextResponse.json({ configured: true, error: "NO_LINKED_ACCOUNT" }, { status: 400 });
  }

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  try {
    const res = await fetch(`${plaidHost(creds.env)}/transactions/get`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: creds.clientId,
        secret: creds.secret,
        access_token: accessToken,
        start_date: monthStart.toISOString().slice(0, 10),
        end_date: now.toISOString().slice(0, 10),
        options: { count: 200, offset: 0 },
      }),
      cache: "no-store",
    });

    if (!res.ok) {
      const detail = await res.text();
      console.error("[plaid/budget] upstream error:", detail);
      return NextResponse.json({ configured: true, error: "PLAID_BUDGET_FAILED" }, { status: 502 });
    }

    const data = await res.json();
    const txns: Array<{ amount: number; personal_finance_category?: { primary: string }; pending?: boolean }> =
      data.transactions ?? [];

    // Aggregate spending by category (exclude pending and positive-flow/income)
    const spending: Record<string, number> = {};
    for (const t of txns) {
      if (t.pending || t.amount <= 0) continue; // skip income and pending
      const raw = t.personal_finance_category?.primary ?? "OTHER";
      const label = CATEGORY_LABELS[raw] ?? "Other";
      spending[label] = (spending[label] ?? 0) + t.amount;
    }

    const budgets = Object.entries(spending)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 6)
      .map(([label, spent]) => {
        const budget = CATEGORY_BUDGETS[label] ?? Math.round(spent * 1.2);
        const pct = Math.min(Math.round((spent / budget) * 100), 120);
        return {
          label,
          spent: `$${Math.round(spent)} / $${budget}`,
          spentAmt: Math.round(spent),
          budgetAmt: budget,
          pct,
          cls: pct >= 100 ? "over" : pct >= 80 ? "" : "good",
        };
      });

    // Generate insights
    const insights = [];
    const over = budgets.filter((b) => b.pct >= 100);
    if (over.length > 0) {
      const b = over[0];
      const excess = b.spentAmt - b.budgetAmt;
      insights.push({
        ic: "↗",
        icColor: "var(--down)",
        title: `${b.label} is over budget by $${excess}`,
        meta: `$${b.spentAmt} vs $${b.budgetAmt} target this month`,
        value: `−$${excess}`,
        up: false,
      });
    }
    const topCategories = Object.entries(spending).sort(([, a], [, b]) => b - a);
    if (topCategories.length >= 2) {
      const [label, amt] = topCategories[0];
      insights.push({
        ic: "↺",
        icColor: undefined,
        title: `${label} is your top category`,
        meta: `$${Math.round(amt)} spent this month`,
        value: `$${Math.round(amt)}`,
        up: false,
      });
    }
    const totalSpent = Object.values(spending).reduce((a, b) => a + b, 0);
    insights.push({
      ic: "📊",
      icColor: undefined,
      title: `$${Math.round(totalSpent)} total spending this month`,
      meta: `Across ${Object.keys(spending).length} categories`,
      value: `$${Math.round(totalSpent)}`,
      up: false,
    });

    return NextResponse.json({ configured: true, budgets, insights });
  } catch {
    return NextResponse.json({ configured: true, error: "PLAID_BUDGET_FAILED" }, { status: 502 });
  }
}
