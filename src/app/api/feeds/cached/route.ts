import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { fetchAndParse, type RssItem } from "@/lib/feeds/rss";

const CACHE_FRESH_HOURS = 20;

type CacheRow = { feed_url: string; items: RssItem[]; fetched_at: string };

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

  for (const url of urls) {
    const cached = cachedByUrl.get(url);
    if (cached && cached.fetched_at > freshCutoff) {
      collected.push(...(cached.items ?? []));
    } else {
      live.push(url);
    }
  }

  if (live.length > 0) {
    const settled = await Promise.allSettled(live.map((url) => fetchAndParse(url)));
    settled.forEach((r, i) => {
      if (r.status === "fulfilled") {
        collected.push(...r.value);
      } else {
        const stale = cachedByUrl.get(live[i]);
        if (stale) collected.push(...(stale.items ?? []));
      }
    });
  }

  const items = collected
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, 24);

  return NextResponse.json({ items });
}
