import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

type HoldingRow = {
  id: string;
  symbol: string;
  name: string;
  shares: number;
  cost_basis: number;
  source: "manual" | "plaid" | "public";
};

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
    .select("id, symbol, name, shares, cost_basis, source, sort_order")
    .eq("user_id", user.id)
    .order("sort_order");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const rows = (data ?? []) as HoldingRow[];

  const bySymbol = new Map<string, { symbol: string; name: string; shares: number; cost_basis: number; sources: string[] }>();
  for (const r of rows) {
    const existing = bySymbol.get(r.symbol);
    if (existing) {
      existing.shares += Number(r.shares);
      existing.cost_basis += Number(r.cost_basis);
      if (!existing.sources.includes(r.source)) existing.sources.push(r.source);
    } else {
      bySymbol.set(r.symbol, {
        symbol: r.symbol,
        name: r.name,
        shares: Number(r.shares),
        cost_basis: Number(r.cost_basis),
        sources: [r.source],
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
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ holding: data });
}
