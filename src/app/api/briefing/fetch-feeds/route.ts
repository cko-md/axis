import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { fetchAndParse, type RssItem } from "@/lib/feeds/rss";
import { recordSafeFetchFailures } from "@/lib/security/safe-fetch-observability";

type FeedSource = { host: string; state: "live" | "failed"; code?: string };

function sourceHost(raw: string) {
  try {
    return new URL(raw).hostname.toLowerCase().replace(/\.+$/, "");
  } catch {
    return "invalid";
  }
}

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
  const settled = await Promise.allSettled(urls.map((url) => fetchAndParse(url)));
  const failureCodes = recordSafeFetchFailures("briefing_feed", settled.flatMap((result, index) =>
    result.status === "rejected" ? [{ rawTarget: urls[index], error: result.reason }] : [],
  ));
  let failureIndex = 0;
  const sources: FeedSource[] = settled.map((result, index) => {
    if (result.status === "fulfilled") return { host: sourceHost(urls[index]), state: "live" };
    const { code } = failureCodes[failureIndex++] ?? { code: "SAFE_FETCH_ROUTE_FAILED" };
    return { host: sourceHost(urls[index]), state: "failed", code };
  });

  const items = settled
    .filter((r): r is PromiseFulfilledResult<RssItem[]> => r.status === "fulfilled")
    .flatMap((r) => r.value)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, 24);

  return NextResponse.json({ items, sources, partial: sources.some((source) => source.state === "failed") });
}
