import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { fetchAndParse, type RssItem } from "@/lib/feeds/rss";
import { recordSafeFetchFailures } from "@/lib/security/safe-fetch-observability";

const CACHE_FRESH_HOURS = 20;

type CacheRow = { feed_url: string; items: RssItem[]; fetched_at: string };
type FeedSource = { host: string; state: "cached" | "live" | "stale" | "failed"; code?: string };

function sourceHost(raw: string) {
  try {
    return new URL(raw).hostname.toLowerCase().replace(/\.+$/, "");
  } catch {
    return "invalid";
  }
}

// Cache-first feed read: serves pre-warmed items from feed_cache (populated by
// /api/cron/feed-digest) for any URL fetched within the last ~20 hours, and
// only live-fetches URLs that are missing or stale — e.g. a feed the user just
// added, which the digest cron hasn't seen yet. If a live fetch fails and a
// stale cached copy exists, that stale copy is served rather than nothing —
// strictly better than the old always-live behavior, never worse.
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let feedUrls: string[];
  try {
    const body = await req.json();
    feedUrls = Array.isArray(body.feedUrls) ? body.feedUrls : [];
  } catch {
    return NextResponse.json({ items: [] });
  }
  if (feedUrls.length === 0) return NextResponse.json({ items: [] });

  const urls = feedUrls.slice(0, 6);
  const freshCutoff = new Date(Date.now() - CACHE_FRESH_HOURS * 3600_000).toISOString();
  const { data: cachedRows } = await supabase
    .from("feed_cache")
    .select("feed_url, items, fetched_at")
    .in("feed_url", urls);

  const cachedByUrl = new Map((cachedRows ?? []).map((r) => [(r as unknown as CacheRow).feed_url, r as unknown as CacheRow]));
  const collected: RssItem[] = [];
  const live: string[] = [];
  const liveIndices: number[] = [];
  const sources: FeedSource[] = new Array(urls.length);

  for (let index = 0; index < urls.length; index += 1) {
    const url = urls[index];
    const cached = cachedByUrl.get(url);
    if (cached && cached.fetched_at > freshCutoff) {
      collected.push(...(cached.items ?? []));
      sources[index] = { host: sourceHost(url), state: "cached" };
    } else {
      live.push(url);
      liveIndices.push(index);
    }
  }

  if (live.length > 0) {
    const settled = await Promise.allSettled(live.map((url) => fetchAndParse(url)));
    const failureCodes = recordSafeFetchFailures("cached_feed", settled.flatMap((result, index) =>
      result.status === "rejected" ? [{ rawTarget: live[index], error: result.reason }] : [],
    ));
    let failureIndex = 0;
    settled.forEach((r, i) => {
      const sourceIndex = liveIndices[i];
      if (r.status === "fulfilled") {
        collected.push(...r.value);
        sources[sourceIndex] = { host: sourceHost(live[i]), state: "live" };
      } else {
        const stale = cachedByUrl.get(live[i]);
        const { code } = failureCodes[failureIndex++] ?? { code: "SAFE_FETCH_ROUTE_FAILED" };
        if (stale) {
          collected.push(...(stale.items ?? []));
          sources[sourceIndex] = { host: sourceHost(live[i]), state: "stale", code };
        } else {
          sources[sourceIndex] = { host: sourceHost(live[i]), state: "failed", code };
        }
      }
    });
  }

  const items = collected
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, 24);

  return NextResponse.json({
    items,
    sources,
    partial: sources.some((source) => source.state === "stale" || source.state === "failed"),
  });
}
