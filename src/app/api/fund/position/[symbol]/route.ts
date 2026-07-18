import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { fetchNews, fetchSnapshot, getPolygonApiKey } from "@/lib/massive/client";
import { redactRouteError } from "@/lib/observability/redactRouteError";

/** GET /api/fund/position/:symbol — cost basis, P/L, portfolio weight, quote, news. */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ symbol: string }> }) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { symbol: rawSymbol } = await params;
  const symbol = rawSymbol.toUpperCase();

  const { data: holdings, error } = await supabase
    .from("fund_holdings")
    .select("shares, cost_basis, source")
    .eq("user_id", user.id)
    .eq("symbol", symbol);
  if (error) return redactRouteError(error, { route: "fund/position/[symbol]", area: "fund" });

  const { data: allHoldings } = await supabase
    .from("fund_holdings")
    .select("symbol, shares, cost_basis")
    .eq("user_id", user.id);

  const shares = (holdings ?? []).reduce((s, h) => s + Number(h.shares), 0);
  const costBasis = (holdings ?? []).reduce((s, h) => s + Number(h.cost_basis), 0);
  const sources = [...new Set((holdings ?? []).map((h) => h.source))];

  let quote: { price: number; chg: number } | null = null;
  let news: Awaited<ReturnType<typeof fetchNews>> = [];
  if (getPolygonApiKey()) {
    try {
      quote = await fetchSnapshot(symbol);
    } catch {
      // simulated fallback handled client-side
    }
    try {
      news = await fetchNews([symbol], 6);
    } catch {
      // news is best-effort
    }
  }

  const positionValue = shares * (quote?.price ?? (shares ? costBasis / shares : 0));
  const totalPortfolioValue = (allHoldings ?? []).reduce((sum, h) => {
    const v = quote && h.symbol === symbol ? Number(h.shares) * quote.price : Number(h.cost_basis);
    return sum + v;
  }, 0);

  return NextResponse.json({
    symbol,
    shares,
    costBasis,
    sources,
    quote,
    news,
    unrealizedPL: positionValue - costBasis,
    weight: totalPortfolioValue ? positionValue / totalPortfolioValue : 0,
  });
}
