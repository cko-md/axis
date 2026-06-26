import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { fetchPrevQuote, getPolygonApiKey } from "@/lib/massive/client";

/**
 * GET /api/massive/movers
 *
 * Market-wide gainers/losers (/v2/snapshot/locale/us/markets/stocks/gainers)
 * returns 403 NOT_AUTHORIZED on the current Polygon plan tier — confirmed
 * live, not a bug: {"status":"NOT_AUTHORIZED","message":"You are not
 * entitled to this data. Please upgrade your plan..."}. Rather than add a
 * new provider/key for a "light" MVP feature, this computes movers from
 * the user's own holdings + watchlist symbols via fetchPrevQuote — the
 * same endpoint /api/massive/quote already uses successfully on this plan.
 * Also more relevant for a personal app than market-wide noise (matches
 * the original spec's "portfolio-relevant market events").
 */
export async function GET() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!getPolygonApiKey()) {
    return NextResponse.json(
      { error: "POLYGON_API_KEY_NOT_CONFIGURED", message: "Set POLYGON_API_KEY to enable movers." },
      { status: 503 },
    );
  }

  const [{ data: holdings }, { data: watchlist }] = await Promise.all([
    supabase.from("fund_holdings").select("symbol").eq("user_id", user.id),
    supabase.from("fund_watchlist").select("symbol").eq("user_id", user.id),
  ]);
  const symbols = [...new Set([...(holdings ?? []), ...(watchlist ?? [])].map((r) => r.symbol))];

  if (symbols.length === 0) {
    return NextResponse.json({ gainers: [], losers: [], empty: true });
  }

  const quotes = await Promise.all(
    symbols.map(async (sym) => {
      try {
        const q = await fetchPrevQuote(sym);
        return { sym, price: q.price, chg: q.chg };
      } catch {
        return null;
      }
    }),
  );
  const valid = quotes.filter((q): q is { sym: string; price: number; chg: number } => q !== null);
  const sorted = [...valid].sort((a, b) => b.chg - a.chg);

  return NextResponse.json({
    gainers: sorted.filter((m) => m.chg > 0).slice(0, 10),
    losers: sorted.filter((m) => m.chg < 0).slice(-10).reverse(),
  });
}
