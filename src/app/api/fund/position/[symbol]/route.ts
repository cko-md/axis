import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createClient } from "@/lib/supabase/server";
import { fetchNews, fetchSnapshot, getPolygonApiKey } from "@/lib/massive/client";
import { redactRouteError } from "@/lib/observability/redactRouteError";
import { minorUnitsToDecimalString, scaledUnitsToDecimalString, strictMinorUnits } from "@/lib/fund/financialTruth";
import { MICRO_SHARES_PER_SHARE } from "@/lib/fund/taxLots";
import {
  calculateLivePosition,
  fetchPortfolioQuotes,
  MAX_PORTFOLIO_QUOTE_SYMBOLS,
  normalizePositionSymbol,
  quoteIsAuthoritative,
  validateAuthoritativeHoldings,
  validateCurrentConnectionBindings,
  validateHoldingCoverage,
  type PositionQuoteInput,
} from "@/lib/fund/positionTruth";

/** GET /api/fund/position/:symbol — cost basis, P/L, portfolio weight, quote, news. */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ symbol: string }> }) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { symbol: rawSymbol } = await params;
  const symbol = normalizePositionSymbol(rawSymbol);
  if (!symbol) return NextResponse.json({ error: "INVALID_SYMBOL" }, { status: 400 });

  const { data: holdings, error } = await supabase
    .from("fund_holdings")
    .select("symbol, shares, cost_basis, source, currency, authority, provider, provider_record_id, connection_id, retrieved_at, reconciliation_state, generation_id")
    .eq("user_id", user.id)
    .eq("symbol", symbol);
  if (error) return redactRouteError(error, { route: "fund/position/[symbol]", area: "fund" });

  const { data: allHoldings, error: allHoldingsError } = await supabase
    .from("fund_holdings")
    .select("symbol, shares, cost_basis, source, currency, authority, provider, provider_record_id, connection_id, retrieved_at, reconciliation_state, generation_id")
    .eq("user_id", user.id)
    .limit(MAX_PORTFOLIO_QUOTE_SYMBOLS + 1);
  if (allHoldingsError) return redactRouteError(allHoldingsError, { route: "fund/position/[symbol]", area: "fund" });
  const { data: connections, error: connectionError } = await supabase
    .from("fund_connections")
    .select("id, provider, status, authority, verified_at")
    .eq("user_id", user.id)
    .limit(32);
  if (connectionError) return redactRouteError(connectionError, { route: "fund/position/[symbol]", area: "fund" });
  const { data: coverage, error: coverageError } = await supabase
    .from("fund_provider_coverage")
    .select("connection_id, provider, component, complete, record_count, retrieved_at, last_attempt_at, availability_status, availability_reason, generation_id, generation_hash")
    .eq("user_id", user.id)
    .eq("component", "holdings")
    .limit(33);
  if (coverageError) return redactRouteError(coverageError, { route: "fund/position/[symbol]", area: "fund" });

  const sources = [...new Set((holdings ?? []).map((h) => h.source))];

  let quote: { price: number; chg: number; source?: unknown; asOf?: unknown } | null = null;
  let news: Awaited<ReturnType<typeof fetchNews>> = [];
  let quotes = new Map<string, PositionQuoteInput>();
  let quoteCoverageReason = (allHoldings ?? []).length > MAX_PORTFOLIO_QUOTE_SYMBOLS
    ? "PORTFOLIO_QUOTE_LIMIT_EXCEEDED" as const
    : validateAuthoritativeHoldings(allHoldings ?? [])
      ?? validateCurrentConnectionBindings(allHoldings ?? [], connections ?? [])
      ?? validateHoldingCoverage(allHoldings ?? [], connections ?? [], coverage ?? []);
  if (getPolygonApiKey() && (holdings ?? []).length > 0 && !quoteCoverageReason) {
    const quoteResult = await fetchPortfolioQuotes((allHoldings ?? []).map((holding) => holding.symbol), fetchSnapshot);
    quotes = quoteResult.quotes;
    quoteCoverageReason = quoteResult.reason;
    const targetQuote = quotes.get(symbol);
    quote = quoteIsAuthoritative(targetQuote) && typeof targetQuote.price === "number" && typeof targetQuote.chg === "number"
      ? targetQuote as { price: number; chg: number; source?: unknown; asOf?: unknown }
      : null;
    try {
      news = await fetchNews([symbol], 6);
    } catch {
      Sentry.captureException(new Error("Fund position news fetch failed"), {
        tags: { area: "fund", provider: "polygon", operation: "position_news" },
      });
    }
  }

  const metrics = calculateLivePosition(symbol, allHoldings ?? [], quotes, Boolean(getPolygonApiKey()), quoteCoverageReason);
  const quoteMinor = quote ? strictMinorUnits(quote.price, "USD") : null;
  const quotePayload = quote && quoteMinor !== null
    ? {
        price: minorUnitsToDecimalString(quoteMinor, "USD"),
        priceMinor: quoteMinor,
        changePercent: quote.chg,
        source: quote.source,
        asOf: quote.asOf,
      }
    : null;

  return NextResponse.json({
    symbol,
    shares: metrics.sharesMicro === null ? null : scaledUnitsToDecimalString(metrics.sharesMicro, MICRO_SHARES_PER_SHARE),
    sharesMicro: metrics.sharesMicro,
    costBasis: metrics.costBasisMinor === null ? null : minorUnitsToDecimalString(metrics.costBasisMinor, "USD"),
    costBasisMinor: metrics.costBasisMinor,
    sources,
    quote: quotePayload,
    quoteAvailable: quotePayload !== null,
    quoteAsOf: quotePayload?.asOf ?? null,
    news,
    liveAvailable: metrics.available,
    liveReason: metrics.reason,
    positionValue: metrics.positionValueMinor === null ? null : minorUnitsToDecimalString(metrics.positionValueMinor, "USD"),
    positionValueMinor: metrics.positionValueMinor,
    unrealizedPL: metrics.unrealizedPLMinor === null ? null : minorUnitsToDecimalString(metrics.unrealizedPLMinor, "USD"),
    unrealizedPLMinor: metrics.unrealizedPLMinor,
    weight: metrics.weight,
  });
}
