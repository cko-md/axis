import { isBlockedUrl } from "@/lib/security/ssrf";

// Shared RSS/Atom fetch + parse — extracted from /api/briefing/fetch-feeds/route.ts
// so the feed-digest cron (src/app/api/cron/feed-digest/route.ts) can pre-warm the
// exact same shape the client-side proxy route returns, instead of two copies of
// this regex parser drifting apart.

export interface RssItem {
  id: string;
  title: string;
  url: string;
  source: string;
  date: string;
  body: string;
  image: string | null;
}

export async function fetchAndParse(url: string): Promise<RssItem[]> {
  if (isBlockedUrl(url)) throw new Error("blocked");
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; Axis/1.0; +feed-reader)" },
    signal: AbortSignal.timeout(6000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  return parseRss(xml, url);
}

export function parseRss(xml: string, feedUrl: string): RssItem[] {
  const items: RssItem[] = [];
  const channelTitle =
    extractFirst(xml, "channel", "title") ??
    new URL(feedUrl).hostname.replace("www.", "");

  // Match both RSS <item> and Atom <entry>
  const blockRe = /<(?:item|entry)>([\s\S]*?)<\/(?:item|entry)>/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(xml)) !== null && items.length < 5) {
    const block = m[1];
    const title = cdata(tag(block, "title"));
    const link = tag(block, "link") || attr(block, "link", "href");
    const desc = cdata(tag(block, "description") ?? tag(block, "summary") ?? tag(block, "content"));
    const date = tag(block, "pubDate") ?? tag(block, "updated") ?? tag(block, "published");

    if (!title || !link) continue;
    items.push({
      id: `${feedUrl}::${title.slice(0, 60)}`,
      title: strip(title).slice(0, 120),
      url: link.trim(),
      source: strip(channelTitle ?? "").slice(0, 40),
      date: date ? new Date(date).toISOString() : new Date().toISOString(),
      body: strip(desc ?? "").slice(0, 240),
      image: extractImage(block),
    });
  }
  return items;
}

function extractFirst(xml: string, parent: string, child: string): string | null {
  const m = xml.match(
    new RegExp(`<${parent}[^>]*>[\\s\\S]*?<${child}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${child}>`, "i"),
  );
  return m?.[1]?.trim() ?? null;
}

function tag(block: string, t: string): string | null {
  const m = block.match(
    new RegExp(`<${t}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${t}>`, "i"),
  );
  return m?.[1]?.trim() ?? null;
}

function attr(block: string, t: string, a: string): string {
  const m = block.match(new RegExp(`<${t}[^>]+${a}="([^"]+)"`, "i"));
  return m?.[1]?.trim() ?? "";
}

/**
 * Pull a preview image from a feed item, in priority order:
 *   media:content / media:thumbnail → enclosure[type=image] → first inline <img>.
 * Returns an absolute http(s) URL or null.
 */
function extractImage(block: string): string | null {
  const httpOk = (u?: string | null): u is string => !!u && /^https?:\/\//i.test(u);

  let m = block.match(/<media:(?:content|thumbnail)[^>]*\burl="([^"]+)"/i);
  if (httpOk(m?.[1])) return m![1];

  m =
    block.match(/<enclosure[^>]*\burl="([^"]+)"[^>]*\btype="image\/[^"]*"/i) ??
    block.match(/<enclosure[^>]*\btype="image\/[^"]*"[^>]*\burl="([^"]+)"/i);
  if (httpOk(m?.[1])) return m![1];

  // Content/description may carry HTML, sometimes entity-escaped.
  const decoded = block
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#34;/g, '"');
  m = decoded.match(/<img[^>]*\bsrc="([^"]+)"/i);
  if (httpOk(m?.[1])) return m![1];

  return null;
}

function cdata(s: string | null): string | null {
  if (!s) return null;
  return s.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").trim();
}

function strip(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
