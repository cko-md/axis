import { timedProviderFetch } from "@/lib/observability/providerTiming";
import { getPolygonApiKeyEnv } from "@/lib/env";

const BASE = "https://api.polygon.io";
const GAP_MS = 280;

let lastRequest = 0;

function providerTimestamp(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  // Polygon timestamps may be seconds, milliseconds, microseconds, or
  // nanoseconds depending on endpoint. Normalize by magnitude, then reject
  // impossible/future values rather than substituting Axis retrieval time.
  let milliseconds = value;
  if (value < 10_000_000_000) milliseconds = value * 1_000;
  else if (value > 10_000_000_000_000_000) milliseconds = value / 1_000_000;
  else if (value > 10_000_000_000_000) milliseconds = value / 1_000;
  const earliest = Date.UTC(2000, 0, 1);
  if (!Number.isFinite(milliseconds) || milliseconds < earliest || milliseconds > Date.now() + 60_000) {
    return null;
  }
  return new Date(milliseconds).toISOString();
}

export function getPolygonApiKey(): string | undefined {
  return getPolygonApiKeyEnv();
}

export function mapSymbol(sym: string): string {
  if (sym === "BTC") return "X:BTCUSD";
  if (sym === "ETH") return "X:ETHUSD";
  return sym;
}

export async function massiveRequest<T>(
  path: string,
  params: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<T> {
  const apiKey = getPolygonApiKey();
  if (!apiKey) {
    throw new Error("POLYGON_API_KEY_NOT_CONFIGURED");
  }

  const wait = Math.max(0, GAP_MS - (Date.now() - lastRequest));
  if (wait) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, wait);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("Massive request aborted", "AbortError"));
      }, { once: true });
    });
  }
  if (signal?.aborted) throw new DOMException("Massive request aborted", "AbortError");
  lastRequest = Date.now();

  const qs = new URLSearchParams(params);
  const url = `${BASE}${path}${qs.size > 0 ? `?${qs}` : ""}`;
  const res = await timedProviderFetch(
    url,
    {
      headers: { Authorization: `Bearer ${apiKey}` },
      next: { revalidate: 60 },
      signal,
    },
    {
      area: "fund",
      provider: "polygon",
      operation: path.split("/").filter(Boolean).slice(0, 3).join("_") || "request",
      timeoutMs: 5_000,
      slowMs: 1_500,
      retry: { maxAttempts: 3, baseDelayMs: 200, maxDelayMs: 1_200 },
      tags: { host: "api.polygon.io" },
    },
  );

  if (!res.ok) {
    const err = new Error(`Massive API ${res.status}`) as Error & {
      status: number;
    };
    err.status = res.status;
    throw err;
  }

  return res.json() as Promise<T>;
}

export interface QuoteResult {
  price: number;
  chg: number;
  open?: number;
  vol?: number;
  source: "massive";
  /** Provider event time. Quotes without one are rejected as unavailable. */
  asOf: string;
  ts?: number;
}

export async function fetchPrevQuote(sym: string, signal?: AbortSignal): Promise<QuoteResult> {
  const j = await massiveRequest<{
    results?: Array<{ c: number; o: number; v: number; t: number }>;
  }>(`/v2/aggs/ticker/${encodeURIComponent(mapSymbol(sym))}/prev`, {
    adjusted: "true",
  }, signal);
  const bar = j.results?.[0];
  if (!bar) throw new Error(`No quote for ${sym}`);
  const asOf = providerTimestamp(bar.t);
  if (!asOf) throw new Error("QUOTE_TIMESTAMP_UNAVAILABLE");
  return {
    price: bar.c,
    chg: bar.o ? ((bar.c - bar.o) / bar.o) * 100 : 0,
    open: bar.o,
    vol: bar.v,
    source: "massive",
    asOf,
    ts: bar.t,
  };
}

export async function fetchSnapshot(sym: string, signal?: AbortSignal): Promise<QuoteResult> {
  // The snapshot endpoint is US-stocks only; crypto falls back to prev-day aggregates
  if (mapSymbol(sym).startsWith("X:")) {
    return fetchPrevQuote(sym, signal);
  }
  const j = await massiveRequest<{
    ticker?: {
      day?: { c: number; o: number };
      lastTrade?: { p: number; t?: number };
      updated?: number;
    };
  }>(
    `/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(mapSymbol(sym))}`,
    {},
    signal,
  );
  const t = j.ticker;
  if (!t?.day) throw new Error(`No snapshot for ${sym}`);
  const p = t.lastTrade?.p ?? t.day.c;
  const chg = t.day.o ? ((p - t.day.o) / t.day.o) * 100 : 0;
  const providerTime = providerTimestamp(t.lastTrade?.t ?? t.updated);
  if (!providerTime) throw new Error("QUOTE_TIMESTAMP_UNAVAILABLE");
  return { price: p, chg, source: "massive", asOf: providerTime };
}

export interface AggBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export async function fetchAggs(
  sym: string,
  from: string,
  to: string,
): Promise<AggBar[]> {
  const j = await massiveRequest<{ results?: AggBar[] }>(
    `/v2/aggs/ticker/${encodeURIComponent(mapSymbol(sym))}/range/1/day/${from}/${to}`,
    { adjusted: "true", sort: "asc", limit: "50000" },
  );
  return j.results ?? [];
}

export interface TickerHit {
  sym: string;
  name: string;
  ex: string;
}

export interface NewsItem {
  title: string;
  url: string;
  publisher: string;
  tickers: string[];
  publishedAt: string;
}

export async function fetchNews(tickers: string[], limit = 10): Promise<NewsItem[]> {
  const j = await massiveRequest<{
    results?: Array<{
      title: string;
      article_url: string;
      publisher?: { name: string };
      tickers?: string[];
      published_utc: string;
    }>;
  }>("/v2/reference/news", {
    ...(tickers.length ? { ticker: tickers.join(",") } : {}),
    limit: String(limit),
  });
  return (j.results ?? []).map((r) => ({
    title: r.title,
    url: r.article_url,
    publisher: r.publisher?.name ?? "",
    tickers: r.tickers ?? [],
    publishedAt: r.published_utc,
  }));
}

export async function searchTickers(q: string): Promise<TickerHit[]> {
  const j = await massiveRequest<{
    results?: Array<{
      ticker: string;
      name: string;
      primary_exchange?: string;
    }>;
  }>("/v3/reference/tickers", {
    search: q,
    active: "true",
    limit: "12",
  });
  return (j.results ?? []).map((r) => ({
    sym: r.ticker,
    name: r.name,
    ex: r.primary_exchange ?? "",
  }));
}
