import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { SafeFetchError, safeFetch, safeFetchHttpStatus } from "@/lib/security/safe-fetch";
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
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
  }

  try {
    const upstream = await safeFetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; AxisReader/1.0)",
        Accept: "text/html,application/xhtml+xml;q=0.9",
      },
      timeoutMs: 12_000,
      maxBodyBytes: MAX_HTML_BYTES,
    });

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

    const article = await extractReadableArticle(html, upstream.url || url.href);
    if (!article) {
      return NextResponse.json({ error: "No readable article content was found." }, { status: 422 });
    }

    return NextResponse.json(
      { url: upstream.url || url.href, ...article },
      { headers: { "Cache-Control": "private, max-age=300" } },
    );
  } catch (error) {
    const code = error instanceof SafeFetchError ? error.code : "READER_FETCH_FAILED";
    if (error instanceof SafeFetchError) {
      // A refused target is an expected policy outcome, not an application
      // exception. Keep only a safe diagnostic breadcrumb.
      Sentry.addBreadcrumb({ category: "safe-fetch", level: "info", data: { operation: "reader_extract", code } });
    } else {
      Sentry.captureException(new Error(code), { tags: { area: "webviewer", operation: "reader_extract", code } });
    }
    return NextResponse.json(
      { error: "Reader view could not load this page.", code },
      { status: safeFetchHttpStatus(error) },
    );
  }
}
