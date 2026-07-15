import { NextRequest, NextResponse } from "next/server";
import { resolveMarketDataAdapter } from "@/lib/markets/adapter";
import { parseSymbolList } from "@/lib/markets/quotes";
import type { MarketQuote } from "@/lib/markets/quote";

/**
 * Batch quotes (§11) — one request for many symbols, instead of the per-symbol
 * N+1 the watchlist used to do. Returns normalized MarketQuotes (provenance +
 * freshness) keyed by symbol, plus per-symbol error codes. Read-only public
 * market data (matches /api/massive/*).
 */
export async function GET(request: NextRequest) {
  const symbols = parseSymbolList(request.nextUrl.searchParams.get("symbols"));
  if (symbols.length === 0) {
    return NextResponse.json({ quotes: {}, errors: {} });
  }

  const adapter = resolveMarketDataAdapter();
  if (!adapter.isConfigured()) {
    return NextResponse.json(
      { error: "not_supported", message: "Market data isn't configured.", quotes: {}, errors: {} },
      { status: 503 },
    );
  }

  const settled = await Promise.all(
    symbols.map(async (symbol) => ({ symbol, result: await adapter.getQuote(symbol) })),
  );

  const quotes: Record<string, MarketQuote> = {};
  const errors: Record<string, string> = {};
  for (const { symbol, result } of settled) {
    if (result.ok) quotes[symbol] = result.data;
    else errors[symbol] = result.error.code;
  }

  return NextResponse.json({ quotes, errors });
}
