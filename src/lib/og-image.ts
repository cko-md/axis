import { safeFetch } from "@/lib/security/safe-fetch";
import { recordSafeFetchFailure } from "@/lib/security/safe-fetch-observability";

export const OG_IMAGE_BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.5",
} as const;

const HTML_TIMEOUT_MS = 8000;
export const OG_IMAGE_TIMEOUT_MS = 8000;
export const OG_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const SAFE_RASTER_TYPES = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp",
]);

function mimeType(value: string | null) {
  return (value ?? "").split(";", 1)[0].trim().toLowerCase();
}

export function isSafeRaster(value: string | null) {
  return SAFE_RASTER_TYPES.has(mimeType(value));
}

/** Resolves an article or direct image URL through the shared outbound boundary. */
export async function resolveOgImageUrl(
  raw: string,
  fetcher: typeof safeFetch = safeFetch,
): Promise<string | null> {
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return null;
  }

  try {
    const res = await fetcher(target.href, {
      headers: OG_IMAGE_BROWSER_HEADERS,
      timeoutMs: HTML_TIMEOUT_MS,
      maxBodyBytes: OG_IMAGE_MAX_BYTES,
    });
    if (!res.ok) return null;
    if (isSafeRaster(res.headers.get("content-type"))) return res.url || target.href;
    if (!(res.headers.get("content-type") ?? "").includes("html")) return null;

    const found = extractMetaImage((await res.text()).slice(0, 256 * 1024));
    if (!found) return null;

    let imageUrl: URL | undefined;
    try {
      imageUrl = new URL(found, res.url || target.href);
      // Remote OG metadata is untrusted. The second hop is policy-checked even
      // when the caller asks only for JSON/meta rather than bytes.
      const imageResponse = await fetcher(imageUrl, {
        headers: { ...OG_IMAGE_BROWSER_HEADERS, Accept: "image/avif,image/webp,image/*,*/*;q=0.8" },
        timeoutMs: OG_IMAGE_TIMEOUT_MS,
        maxBodyBytes: OG_IMAGE_MAX_BYTES,
        // We only need the already policy-checked response metadata here. Do
        // not buffer an arbitrary remote image merely to validate its MIME.
        responseBodyMode: "discard",
      });
      return imageResponse.ok && isSafeRaster(imageResponse.headers.get("content-type"))
        ? imageResponse.url || imageUrl.href
        : null;
    } catch (error) {
      recordSafeFetchFailure("og_image_meta", imageUrl?.href ?? target.href, error);
      return null;
    }
  } catch (error) {
    recordSafeFetchFailure("og_image_resolve", target.href, error);
    return null;
  }
}

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
    const content = tag.match(/\bcontent=["']([^"']+)["']/i)?.[1] ?? tag.match(/\bcontent=([^\s>]+)/i)?.[1];
    if (content && /^https?:\/\//i.test(content)) return decodeEntities(content.trim());
  }
  const linkTag = html.match(/<link[^>]+rel=["']image_src["'][^>]*>/i)?.[0];
  const href = linkTag?.match(/\bhref=["']([^"']+)["']/i)?.[1];
  return href && /^https?:\/\//i.test(href) ? decodeEntities(href.trim()) : null;
}

function decodeEntities(s: string): string {
  // Decode only entities present in the original source. Chained replace calls
  // would turn &amp;#38; into a second-stage entity, changing an untrusted URL.
  const entities: Record<string, string> = {
    amp: "&", "#38": "&", quot: '"', "#34": '"', "#39": "'", lt: "<", gt: ">",
  };
  return s.replace(/&(amp|#38|quot|#34|#39|lt|gt);/gi, (entity) => entities[entity.slice(1, -1).toLowerCase()] ?? entity);
}
