import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

type HoldingRow = {
  id: string;
  symbol: string;
  name: string;
  shares: number;
  cost_basis: number;
  source: "manual" | "plaid" | "public";
  retrieved_at: string | null;
};

/** Oldest of two nullable ISO timestamps (the conservative freshness anchor). */
function olderOf(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) <= Date.parse(b) ? a : b;
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
    .select("id, symbol, name, shares, cost_basis, source, sort_order, retrieved_at")
    .eq("user_id", user.id)
    .order("sort_order");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const rows = (data ?? []) as HoldingRow[];

  const bySymbol = new Map<string, { symbol: string; name: string; shares: number; cost_basis: number; sources: string[]; retrieved_at: string | null }>();
  for (const r of rows) {
    const existing = bySymbol.get(r.symbol);
    if (existing) {
      existing.shares += Number(r.shares);
      existing.cost_basis += Number(r.cost_basis);
      if (!existing.sources.includes(r.source)) existing.sources.push(r.source);
      // Aggregate freshness = the oldest constituent (most conservative).
      existing.retrieved_at = olderOf(existing.retrieved_at, r.retrieved_at);
    } else {
      bySymbol.set(r.symbol, {
        symbol: r.symbol,
        name: r.name,
        shares: Number(r.shares),
        cost_basis: Number(r.cost_basis),
        sources: [r.source],
        retrieved_at: r.retrieved_at,
      });
    }
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
      // Provenance: a manually entered holding is "as of" now, in USD.
      provider: "manual",
      retrieved_at: new Date().toISOString(),
      currency: "USD",
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ holding: data });
}
