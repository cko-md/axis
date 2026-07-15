/**
 * Market-data adapter contract (§10). API routes select an adapter and call
 * generic methods returning the shared `Result<MarketQuote>` — they never branch
 * on the provider. Today the only implementation is Polygon/Massive; adding
 * another (or a cache-first wrapper) means implementing this interface, not
 * touching call sites.
 */

import { fetchPrevQuote, fetchSnapshot, getPolygonApiKey } from "@/lib/massive/client";
import { fail, failFromException, ok, type Result } from "@/lib/integrations/types";
import { normalizeQuote, type MarketQuote } from "./quote";

export interface MarketDataAdapter {
  readonly provider: string;
  /** Whether the provider is configured (API key present). */
  isConfigured(): boolean;
  /**
   * Latest quote for a symbol. `snapshot` requests an intraday snapshot where
   * supported; otherwise the prior session close is returned.
   */
  getQuote(symbol: string, opts?: { snapshot?: boolean }): Promise<Result<MarketQuote>>;
}

/** Polygon / Massive adapter over the existing rate-limited client. */
export const polygonMarketAdapter: MarketDataAdapter = {
  provider: "polygon",

  isConfigured() {
    return !!getPolygonApiKey();
  },

  async getQuote(symbol, opts) {
    if (!getPolygonApiKey()) {
      return fail<MarketQuote>(
        "not_supported",
        "Market data isn't configured (set POLYGON_API_KEY / MASSIVE_API_KEY).",
        { provider: "polygon", retryable: false },
      );
    }
    const sym = symbol.trim().toUpperCase();
    if (!sym) return fail<MarketQuote>("invalid_request", "Symbol is required.", { provider: "polygon" });

    try {
      const raw = opts?.snapshot ? await fetchSnapshot(sym) : await fetchPrevQuote(sym);
      return ok(normalizeQuote(sym, { price: raw.price, chg: raw.chg, ts: raw.ts }, { provider: "polygon" }));
    } catch (e) {
      // "No quote for X" from the client is a not-found; everything else maps by
      // status (429 → rate_limited, 5xx → provider_error) or to network.
      if (e instanceof Error && /no quote/i.test(e.message)) {
        return fail<MarketQuote>("not_found", `No quote available for ${sym}.`, { provider: "polygon" });
      }
      return failFromException<MarketQuote>(e, `Failed to fetch a quote for ${sym}.`, {
        provider: "polygon",
      });
    }
  },
};

/** Resolve the active market-data adapter (single provider today). */
export function resolveMarketDataAdapter(): MarketDataAdapter {
  return polygonMarketAdapter;
}
