import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isBlockedUrl } from "@/lib/security/ssrf";

/**
 * GET /api/og-image?url=<page-or-image>
 *
 * Two responsibilities, both server-side so they dodge browser CORS / 403
 * hotlink-protection that silently break <img>/background-image previews:
 *
 *   1. Resolve a preview image for an article/recipe page by scraping its
 *      <head> for og:image → twitter:image → <link rel="image_src">.
 *   2. Proxy the resolved (or directly-supplied) image bytes back with the
 *      upstream content-type so the browser loads it same-origin.
 *
 * Modes:
 *   - default            → stream the image bytes (use directly as an <img>/bg src)
 *   - ?meta=1 / ?json=1  → return { image: <absolute url> | null } as JSON
 *
 * Always resilient: short timeouts, never throws to the client, returns a
 * 404/null on any failure so callers can fall back to a gradient placeholder.
 */

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.5",
} as const;

const HTML_TIMEOUT_MS = 8000;
const IMAGE_TIMEOUT_MS = 8000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8MB ceiling for a preview image

export async function GET(req: NextRequest) {
  // Auth guard — this route performs server-side fetches on behalf of the user.
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const raw = req.nextUrl.searchParams.get("url") ?? "";
  const wantsJson =
    req.nextUrl.searchParams.get("meta") === "1" ||
    req.nextUrl.searchParams.get("json") === "1";

  if (!raw) {
    return wantsJson
      ? NextResponse.json({ image: null }, { status: 400 })
      : new NextResponse("Missing url", { status: 400 });
  }
  if (isBlockedUrl(raw)) {
    return wantsJson
      ? NextResponse.json({ image: null }, { status: 403 })
      : new NextResponse("Forbidden", { status: 403 });
  }

  const resolved = await resolveImageUrl(raw);

  if (wantsJson) {
    return NextResponse.json(
      { image: resolved },
      { headers: { "Cache-Control": "public, max-age=3600" } },
    );
  }

  if (!resolved) {
    // No image could be resolved — 404 lets the browser/onError fall back.
    return new NextResponse("No image", { status: 404 });
  }

  return streamImage(resolved);
}

/**
 * Resolve an absolute image URL from `raw`. If `raw` is already an image, it is
 * returned as-is; otherwise the page is fetched and its <head> scraped for
 * og:image / twitter:image / <link rel="image_src">. Returns null on failure.
 */
async function resolveImageUrl(raw: string): Promise<string | null> {
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return null;
  }

  // Cheap shortcut: obvious image URLs by extension are used directly (still
  // proxied for bytes, but no need to fetch+parse HTML first).
  if (/\.(png|jpe?g|gif|webp|avif|svg)(\?|$)/i.test(target.pathname)) {
    return target.href;
  }

  try {
    const res = await fetch(target.href, {
      headers: BROWSER_HEADERS,
      signal: AbortSignal.timeout(HTML_TIMEOUT_MS),
      redirect: "follow",
      cache: "no-store",
    });
    if (!res.ok) return null;

    const ct = res.headers.get("content-type") ?? "";
    // The URL turned out to be an image after all (no usable extension).
    if (ct.startsWith("image/")) return res.url || target.href;
    if (!ct.includes("html")) return null;

    // Only need the <head>; cap how much we read so a giant page can't stall us.
    const html = (await res.text()).slice(0, 256 * 1024);
    const found = extractMetaImage(html);
    if (!found) return null;

    // Resolve relative URLs against the (possibly redirected) final URL.
    try {
      return new URL(found, res.url || target.href).href;
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

/**
 * Pull a preview image from page HTML, in priority order:
 *   og:image / og:image:secure_url → twitter:image(:src) → <link rel=image_src>.
 */
function extractMetaImage(html: string): string | null {
  const metaPatterns: RegExp[] = [
    /<meta[^>]+(?:property|name)=["']og:image:secure_url["'][^>]*>/i,
    /<meta[^>]+(?:property|name)=["']og:image:url["'][^>]*>/i,
    /<meta[^>]+(?:property|name)=["']og:image["'][^>]*>/i,
    /<meta[^>]+(?:name|property)=["']twitter:image:src["'][^>]*>/i,
    /<meta[^>]+(?:name|property)=["']twitter:image["'][^>]*>/i,
  ];

  for (const re of metaPatterns) {
    const tag = html.match(re)?.[0];
    if (!tag) continue;
    const content =
      tag.match(/\bcontent=["']([^"']+)["']/i)?.[1] ??
      tag.match(/\bcontent=([^\s>]+)/i)?.[1];
    if (content && httpOk(content)) return decodeEntities(content.trim());
  }

  // <link rel="image_src" href="...">
  const linkTag = html.match(/<link[^>]+rel=["']image_src["'][^>]*>/i)?.[0];
  if (linkTag) {
    const href = linkTag.match(/\bhref=["']([^"']+)["']/i)?.[1];
    if (href && httpOk(href)) return decodeEntities(href.trim());
  }

  return null;
}

/** Fetch the image bytes and stream them back with the upstream content-type. */
async function streamImage(imageUrl: string): Promise<NextResponse> {
  if (isBlockedUrl(imageUrl)) return new NextResponse("Forbidden", { status: 403 });

  try {
    const upstream = await fetch(imageUrl, {
      headers: { ...BROWSER_HEADERS, Accept: "image/avif,image/webp,image/*,*/*;q=0.8" },
      signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
      redirect: "follow",
      cache: "no-store",
    });

    const ct = upstream.headers.get("content-type") ?? "";
    if (!upstream.ok || !ct.startsWith("image/")) {
      return new NextResponse("Not an image", { status: 404 });
    }

    const len = Number(upstream.headers.get("content-length") ?? "0");
    if (len && len > MAX_IMAGE_BYTES) {
      return new NextResponse("Image too large", { status: 413 });
    }

    const buf = await upstream.arrayBuffer();
    if (buf.byteLength > MAX_IMAGE_BYTES) {
      return new NextResponse("Image too large", { status: 413 });
    }

    return new NextResponse(buf, {
      status: 200,
      headers: {
        "Content-Type": ct,
        // Preview images are effectively immutable; cache hard at the edge.
        "Cache-Control": "public, max-age=86400, s-maxage=86400, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new NextResponse("Fetch failed", { status: 404 });
  }
}

function httpOk(u: string): boolean {
  return /^https?:\/\//i.test(u);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&#38;/g, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}
