import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isBlockedUrl } from "@/lib/security/ssrf";
import { extractReadableArticle } from "@/lib/web-reader";

// jsdom requires the Node.js runtime (not edge) and must not be bundled — see
// serverExternalPackages in next.config.ts.
export const runtime = "nodejs";

const MAX_HTML_BYTES = 5_000_000;

export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rawUrl = req.nextUrl.searchParams.get("url")?.trim() ?? "";
  if (!rawUrl) return NextResponse.json({ error: "Missing URL" }, { status: 400 });
  if (isBlockedUrl(rawUrl)) return NextResponse.json({ error: "This URL cannot be opened safely." }, { status: 403 });

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
  }

  try {
    const upstream = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; AxisReader/1.0)",
        Accept: "text/html,application/xhtml+xml;q=0.9",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(12_000),
      cache: "no-store",
    });

    if (isBlockedUrl(upstream.url)) {
      return NextResponse.json({ error: "The page redirected to a blocked URL." }, { status: 403 });
    }

    if (!upstream.ok) {
      return NextResponse.json({ error: `The page returned ${upstream.status}.` }, { status: 422 });
    }

    const contentType = upstream.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
      return NextResponse.json({ error: "Reader view supports web articles only." }, { status: 415 });
    }

    const length = Number(upstream.headers.get("content-length") ?? "0");
    if (Number.isFinite(length) && length > MAX_HTML_BYTES) {
      return NextResponse.json({ error: "This page is too large for reader view." }, { status: 413 });
    }

    const html = await upstream.text();
    if (Buffer.byteLength(html, "utf8") > MAX_HTML_BYTES) {
      return NextResponse.json({ error: "This page is too large for reader view." }, { status: 413 });
    }

    const article = extractReadableArticle(html, upstream.url || url.href);
    if (!article) {
      return NextResponse.json({ error: "No readable article content was found." }, { status: 422 });
    }

    return NextResponse.json(
      { url: upstream.url || url.href, ...article },
      { headers: { "Cache-Control": "private, max-age=300" } },
    );
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error("Reader extraction failed"), {
      tags: { area: "webviewer", operation: "reader_extract" },
      extra: { hostname: url.hostname },
    });
    return NextResponse.json({ error: "Reader view could not load this page." }, { status: 502 });
  }
}
