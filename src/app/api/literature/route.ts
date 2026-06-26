import { NextResponse } from "next/server";
import { type Article, fetchPubMed, fetchBioRxiv, fetchArxiv, buildQueries } from "@/lib/literature/sources";

// ── Literature feed ───────────────────────────────────────────────────────────
// Aggregates REAL recent neuroscience-relevant articles from free, no-auth sources
// (PubMed, bioRxiv/medRxiv, arXiv q-bio — see src/lib/literature/sources.ts for the
// fetchers, shared with the cron paper-watch in src/lib/literature/watch.ts).
// Each source degrades independently: a single unreachable source never breaks the
// response. Results are normalized to the Article shape and cached server-side.

export const revalidate = 0; // we manage caching ourselves below
export type { Article };

type FeedResponse = {
  articles: Article[];
  sources: { name: string; ok: boolean; count: number }[];
  query: string;
  fetchedAt: string;
  fallback?: boolean;
};

// ── Server-side cache ──────────────────────────────────────────────────────────
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const cache = new Map<string, { at: number; payload: FeedResponse }>();

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  // `topic` may be a single key or a comma-separated set; we merge across them.
  const rawKeys = (params.get("topic") || "neuroscience")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const topicKeys = rawKeys.length ? rawKeys : ["neuroscience"];
  const customQuery = params.get("q")?.trim();

  const cacheKey = customQuery ? `q:${customQuery}` : `t:${[...topicKeys].sort().join("+")}`;
  const now = Date.now();
  const cached = cache.get(cacheKey);
  if (cached && now - cached.at < CACHE_TTL_MS && !params.has("nocache")) {
    return NextResponse.json({ ...cached.payload, cached: true });
  }

  // Build per-source query terms. Unknown keys fall back to verbatim free-text search.
  const { pubmedQuery, biorxivKeyword, arxivQuery, label } = buildQueries(topicKeys, customQuery);

  const sources: { name: string; ok: boolean; count: number }[] = [];

  const settled = await Promise.allSettled([
    fetchPubMed(pubmedQuery, 14),
    fetchBioRxiv("biorxiv", 6, biorxivKeyword),
    fetchBioRxiv("medrxiv", 4, biorxivKeyword),
    fetchArxiv(arxivQuery, 6),
  ]);

  const names = ["PubMed", "bioRxiv", "medRxiv", "arXiv q-bio"];
  const collected: Article[] = [];
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") {
      sources.push({ name: names[i], ok: true, count: s.value.length });
      collected.push(...s.value);
    } else {
      sources.push({ name: names[i], ok: false, count: 0 });
    }
  });

  // De-dupe by id, sort newest first.
  const seen = new Set<string>();
  const articles = collected
    .filter((a) => {
      if (seen.has(a.id)) return false;
      seen.add(a.id);
      return true;
    })
    .sort((a, b) => +new Date(b.publishedAt) - +new Date(a.publishedAt));

  const payload: FeedResponse = {
    articles,
    sources,
    query: label,
    fetchedAt: new Date().toISOString(),
    fallback: articles.length === 0,
  };

  // Only cache successful, non-empty payloads so a transient outage doesn't get pinned.
  if (articles.length > 0) cache.set(cacheKey, { at: now, payload });

  return NextResponse.json(payload);
}
