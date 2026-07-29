import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { safeFetch } from "@/lib/security/safe-fetch";
import { recordSafeFetchFailure } from "@/lib/security/safe-fetch-observability";
import {
  isSafeRaster,
  OG_IMAGE_BROWSER_HEADERS,
  OG_IMAGE_MAX_BYTES,
  OG_IMAGE_TIMEOUT_MS,
  resolveOgImageUrl,
} from "@/lib/og-image";

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
  const resolved = await resolveOgImageUrl(raw);

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

/** Fetch the image bytes and stream them back with the upstream content-type. */
async function streamImage(imageUrl: string): Promise<NextResponse> {
  try {
    const upstream = await safeFetch(imageUrl, {
      headers: { ...OG_IMAGE_BROWSER_HEADERS, Accept: "image/avif,image/webp,image/*,*/*;q=0.8" },
      timeoutMs: OG_IMAGE_TIMEOUT_MS,
      maxBodyBytes: OG_IMAGE_MAX_BYTES,
    });

    const ct = upstream.headers.get("content-type") ?? "";
    // SVG is active content, not a safe raster preview. Never proxy it through
    // a same-origin image endpoint.
    if (!upstream.ok || !isSafeRaster(ct)) {
      return new NextResponse("Not an image", { status: 404 });
    }

    const len = Number(upstream.headers.get("content-length") ?? "0");
    if (len && len > OG_IMAGE_MAX_BYTES) {
      return new NextResponse("Image too large", { status: 413 });
    }

    const buf = await upstream.arrayBuffer();
    if (buf.byteLength > OG_IMAGE_MAX_BYTES) {
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
  } catch (error) {
    recordSafeFetchFailure("og_image_stream", imageUrl, error);
    return new NextResponse("Fetch failed", { status: 404 });
  }
}
