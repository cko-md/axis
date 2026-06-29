import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { fetchAndParse, type RssItem } from "@/lib/feeds/rss";

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

  const settled = await Promise.allSettled(
    feedUrls.slice(0, 6).map((url) => fetchAndParse(url)),
  );

  const items = settled
    .filter((r): r is PromiseFulfilledResult<RssItem[]> => r.status === "fulfilled")
    .flatMap((r) => r.value)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, 24);

  return NextResponse.json({ items });
}
