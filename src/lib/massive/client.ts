import { timedProviderFetch } from "@/lib/observability/providerTiming";
import { getPolygonApiKeyEnv } from "@/lib/env";

const BASE = "https://api.polygon.io";
const GAP_MS = 280;

let lastRequest = 0;

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
): Promise<T> {
  const apiKey = getPolygonApiKey();
  if (!apiKey) {
    throw new Error("POLYGON_API_KEY_NOT_CONFIGURED");
  }

  const wait = Math.max(0, GAP_MS - (Date.now() - lastRequest));
  if (wait) await new Promise((r) => setTimeout(r, wait));
  lastRequest = Date.now();

  const qs = new URLSearchParams({ ...params, apiKey });
  const res = await timedProviderFetch(
    `${BASE}${path}?${qs}`,
    { next: { revalidate: 60 } },
    {
      area: "fund",
      provider: "polygon",
      operation: path.split("/").filter(Boolean).slice(0, 3).join("_") || "request",
      timeoutMs: 5_000,
      slowMs: 1_500,
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
  source: "live";
  ts?: number;
}

export async function fetchPrevQuote(sym: string): Promise<QuoteResult> {
  const j = await massiveRequest<{
    results?: Array<{ c: number; o: number; v: number; t: number }>;
  }>(`/v2/aggs/ticker/${encodeURIComponent(mapSymbol(sym))}/prev`, {
    adjusted: "true",
  });
  const bar = j.results?.[0];
  if (!bar) throw new Error(`No quote for ${sym}`);
  return {
    price: bar.c,
    chg: bar.o ? ((bar.c - bar.o) / bar.o) * 100 : 0,
    open: bar.o,
    vol: bar.v,
    source: "live",
    ts: bar.t,
  };
}

export async function fetchSnapshot(sym: string): Promise<QuoteResult> {
  // The snapshot endpoint is US-stocks only; crypto falls back to prev-day aggregates
  if (mapSymbol(sym).startsWith("X:")) {
    return fetchPrevQuote(sym);
  }
  const j = await massiveRequest<{
    ticker?: {
      day?: { c: number; o: number };
      lastTrade?: { p: number };
    };
  }>(
    `/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(mapSymbol(sym))}`,
    {},
  );
  const t = j.ticker;
  if (!t?.day) throw new Error(`No snapshot for ${sym}`);
  const p = t.lastTrade?.p ?? t.day.c;
  const chg = t.day.o ? ((p - t.day.o) / t.day.o) * 100 : 0;
  return { price: p, chg, source: "live" };
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
