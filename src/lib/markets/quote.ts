/**
 * Market-data domain quote — the normalized, provenance-aware shape the app
 * consumes, independent of the provider (Polygon/Massive today). This is the
 * §10 "provider models → domain models" boundary for market data, and it ties
 * quotes into the provenance/freshness kernel (§4) so a delayed price is never
 * shown as real-time.
 *
 * The normalization is pure and unit-tested; the impure adapter (adapter.ts)
 * fetches raw provider data and hands it here.
 */

import {
  classifyFreshness,
  FRESHNESS_SLAS,
  type FreshnessTier,
  type Provenance,
} from "@/lib/fund/provenance";

/** A normalized quote with where it came from and how fresh it is. */
export type MarketQuote = {
  symbol: string;
  /** Last price in major units of `currency`. */
  price: number;
  currency: string;
  /** Percent change vs the session open (or prior close), as provided. */
  changePct: number;
  provenance: Provenance;
  freshness: FreshnessTier;
};

/** The raw fields an adapter extracts from a provider response. */
export type RawQuote = {
  price: number;
  /** Percent change. */
  chg: number;
  /** Provider epoch-ms timestamp of the bar/quote, if known. */
  ts?: number;
};

export type NormalizeQuoteOptions = {
  provider: string;
  /** Reference time (defaults to now), for deterministic tests. */
  now?: number;
  /** ISO-4217 currency the price is in (Polygon US equities/crypto → USD). */
  currency?: string;
};

/**
 * Build a {@link MarketQuote} from a raw provider quote, stamping provenance
 * (provider, retrieval + effective timestamps, currency) and classifying
 * freshness against the market-price SLA. Non-finite price/change are coerced to
 * 0 rather than propagating NaN.
 */
export function normalizeQuote(
  symbol: string,
  raw: RawQuote,
  opts: NormalizeQuoteOptions,
): MarketQuote {
  const now = opts.now ?? Date.now();
  const currency = opts.currency ?? "USD";
  const retrievedAt = new Date(now).toISOString();
  const effectiveAt =
    typeof raw.ts === "number" && Number.isFinite(raw.ts)
      ? new Date(raw.ts).toISOString()
      : undefined;

  const provenance: Provenance = {
    provider: opts.provider,
    retrievedAt,
    ...(effectiveAt ? { effectiveAt } : {}),
    currency,
  };

  return {
    symbol: symbol.toUpperCase(),
    price: Number.isFinite(raw.price) ? raw.price : 0,
    currency,
    changePct: Number.isFinite(raw.chg) ? raw.chg : 0,
    provenance,
    // Freshness is judged from when the price was effective (its bar time),
    // falling back to retrieval time — so a stale market feed reads as stale.
    freshness: classifyFreshness(effectiveAt ?? retrievedAt, FRESHNESS_SLAS.marketPrice, now),
  };
}
