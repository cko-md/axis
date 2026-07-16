import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAndParse } from "@/lib/feeds/rss";
import { optionalEnv } from "@/lib/env";
import type { Json } from "@/lib/supabase/database.types";

const CACHE_FRESH_HOURS = 20;

// Mirrors VitalityModule.tsx's "Running Briefing" card feed list.
const VITALITY_RUN_FEEDS = [
  "https://www.letsrun.com/feed/",
  "https://www.runnersworld.com/rss/all.xml/",
  "https://www.dcrainmaker.com/feed",
  "https://www.outsideonline.com/feed",
];

// Mirrors AtelierModule.tsx's LANG_FEEDS + MENS_STYLE_FEEDS.
const ATELIER_FEEDS = [
  "https://www.rfi.fr/fr/rss",
  "https://www.notesinspanish.com/feed/",
  "https://feeds.bbci.co.uk/yoruba/rss.xml",
  "https://www.esquire.com/rss/all.xml/",
  "https://www.permanentstyle.com/feed",
  "https://www.gq.com/feed/rss",
  "https://hespokestyle.com/feed/",
];

// Make-triggered daily pre-warm of the shared feed_cache table: unions every
// signed-in user's subscribed briefing_feeds with Vitality's and Atelier's
// hardcoded RSS lists, then fetches any URL not already cached within the
// last ~20 hours. Cache is keyed by feed_url (not user_id) — multiple users
// following the same public feed share one fetch, and there's no per-user
// loop needed (unlike intelligence-sweep, which acts on per-user data).
//
// Auth: bearer FEED_DIGEST_SECRET — a dedicated secret for this channel, not
// CRON_SECRET (Vercel cron) or MAKE_SWEEP_SECRET (intelligence-sweep).
export async function POST(req: NextRequest) {
  const digestSecret = optionalEnv("FEED_DIGEST_SECRET");
  if (!digestSecret) {
    return NextResponse.json({ error: "FEED_DIGEST_SECRET not configured" }, { status: 503 });
  }
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${digestSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();
  if (!supabase) {
    return NextResponse.json({ error: "SUPABASE_SERVICE_ROLE_KEY not configured" }, { status: 503 });
  }

  const urls = new Set<string>([...VITALITY_RUN_FEEDS, ...ATELIER_FEEDS]);

  // Paginate defensively — a personal-OS deployment could grow past one page
  // of subscribed feeds across all users (same caution as intelligence-sweep's
  // listUsers loop).
  let from = 0;
  const PAGE_SIZE = 1000;
  for (;;) {
    const { data, error } = await supabase.from("briefing_feeds").select("url").range(from, from + PAGE_SIZE - 1);
    if (error || !data) break;
    data.forEach((row) => urls.add(row.url as string));
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  const freshCutoff = new Date(Date.now() - CACHE_FRESH_HOURS * 3600_000).toISOString();
  const { data: cachedRows } = await supabase
    .from("feed_cache")
    .select("feed_url, fetched_at")
    .in("feed_url", [...urls]);
  const freshUrls = new Set(
    (cachedRows ?? []).filter((r) => (r.fetched_at as string) > freshCutoff).map((r) => r.feed_url as string),
  );

  const toFetch = [...urls].filter((u) => !freshUrls.has(u));
  const fetched = await Promise.allSettled(toFetch.map((url) => fetchAndParse(url)));

  let updated = 0;
  let failed = 0;
  for (let i = 0; i < toFetch.length; i++) {
    const result = fetched[i];
    if (result.status !== "fulfilled") {
      failed += 1;
      continue;
    }
    const { error } = await supabase
      .from("feed_cache")
      .upsert({
        feed_url: toFetch[i],
        items: result.value as unknown as Json,
        fetched_at: new Date().toISOString(),
      });
    if (error) failed += 1;
    else updated += 1;
  }

  return NextResponse.json({ ok: true, totalFeeds: urls.size, alreadyFresh: freshUrls.size, updated, failed });
}
