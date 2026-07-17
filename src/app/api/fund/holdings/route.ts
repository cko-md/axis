import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createClient } from "@/lib/supabase/server";
import { reconcileHoldings } from "@/lib/fund/reconcileHoldings";
import type { ReconciliationState } from "@/lib/fund/provenance";
import { toMajorUnitsIn, toMinorUnitsIn } from "@/lib/fund/currency";

type HoldingRow = {
  id: string;
  symbol: string;
  name: string;
  shares: number;
  cost_basis: number;
  source: "manual" | "plaid" | "public";
  currency: string | null;
  reconciliation_state: ReconciliationState | null;
  retrieved_at: string | null;
};

/** Oldest of two nullable ISO timestamps (the conservative freshness anchor). */
function olderOf(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

function normalizeCurrency(currency: string | null | undefined): string {
  const code = (currency ?? "").trim().toUpperCase();
  return code === "" ? "USD" : code;
}

/**
 * GET /api/fund/holdings
 *
 * Promotes the inline Supabase calls that used to live in FundModule.tsx
 * into a real route, and adds the source-aware aggregation decision #9
 * requires: rows from different sources (manual/plaid/public) are never
 * merged into one row — they're summed by symbol here for display, while
 * `rows` still exposes each source-tagged row individually.
 */
export async function GET() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("fund_holdings")
    .select("id, symbol, name, shares, cost_basis, source, sort_order, currency, reconciliation_state, retrieved_at")
    .eq("user_id", user.id)
    .order("sort_order");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const rows = (data ?? []) as HoldingRow[];

  // Reconcile per symbol across sources (pure, deterministic, minor-unit).
  const reconciliation = reconcileHoldings(rows);

  const bySymbol = new Map<string, { symbol: string; name: string; shares: number; cost_basis: number; sources: string[]; currency: string | null; reconciliation_state: ReconciliationState | null; retrieved_at: string | null }>();
  for (const r of rows) {
    const currency = normalizeCurrency(r.currency);
    const existing = bySymbol.get(r.symbol);
    if (existing) {
      existing.shares += Number(r.shares);
      if (!existing.sources.includes(r.source)) existing.sources.push(r.source);
      if (existing.currency === currency) {
        existing.cost_basis = toMajorUnitsIn(
          toMinorUnitsIn(existing.cost_basis, currency) + toMinorUnitsIn(r.cost_basis, currency),
          currency,
        );
      } else {
        existing.cost_basis += Number(r.cost_basis);
        existing.currency = null;
      }
      // Aggregate freshness = the oldest constituent (most conservative).
      existing.retrieved_at = olderOf(existing.retrieved_at, r.retrieved_at);
    } else {
      bySymbol.set(r.symbol, {
        symbol: r.symbol,
        name: r.name,
        shares: Number(r.shares),
        cost_basis: Number(r.cost_basis),
        sources: [r.source],
        currency,
        reconciliation_state: reconciliation.get(r.symbol)?.state ?? null,
        retrieved_at: r.retrieved_at,
      });
    }
  }

  // Persist the freshly computed state back to any symbol group whose stored
  // value drifted from the computed one. Best-effort: a write failure must not
  // fail the read, but it is never swallowed silently — it is reported to
  // Sentry as a scoped warning so the drift stays visible.
  const changedSymbols: string[] = [];
  for (const [symbol, recon] of reconciliation) {
    const stored = rows.filter((r) => r.symbol === symbol);
    // A group needs a write when any of its rows disagrees with the computed state.
    if (stored.some((r) => (r.reconciliation_state ?? null) !== recon.state)) {
      changedSymbols.push(symbol);
    }
  }

  if (changedSymbols.length > 0) {
    await Promise.all(
      changedSymbols.map(async (symbol) => {
        const state = reconciliation.get(symbol)?.state ?? null;
        const { error: updateError } = await supabase
          .from("fund_holdings")
          .update({ reconciliation_state: state })
          .eq("user_id", user.id)
          .eq("symbol", symbol);
        if (updateError) {
          Sentry.captureException(updateError, {
            level: "warning",
            tags: { area: "fund", op: "persist_reconciliation_state", route: "/api/fund/holdings" },
            extra: { symbol, computedState: state },
          });
        }
      }),
    );
  }

  return NextResponse.json({ rows, aggregated: [...bySymbol.values()] });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const symbol = String(body.symbol ?? "").trim().toUpperCase();
  const shares = Number(body.shares);
  const costBasis = Number(body.cost_basis);
  if (!symbol || !Number.isFinite(shares) || shares < 0 || !Number.isFinite(costBasis) || costBasis < 0) {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }

  const { count } = await supabase
    .from("fund_holdings")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id);

  const { data, error } = await supabase
    .from("fund_holdings")
    .insert({
      user_id: user.id,
      symbol,
      name: String(body.name ?? symbol),
      shares,
      cost_basis: costBasis,
      source: "manual",
      sort_order: count ?? 0,
      // Provenance: for a manual entry, entry time IS the retrieval time.
      provider: "manual",
      retrieved_at: new Date().toISOString(),
      currency: "USD",
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ holding: data });
}
