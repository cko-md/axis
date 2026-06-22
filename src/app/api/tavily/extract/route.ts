import { NextRequest, NextResponse } from "next/server";
import DOMPurify from "isomorphic-dompurify";
import { createClient } from "@/lib/supabase/server";
import { isBlockedUrl } from "@/lib/security/ssrf";
import { tavilyExtractOne, TavilyError } from "@/lib/integrations/tavily";

/**
 * POST/GET /api/tavily/extract?url=...
 *
 * Auth-guarded. Returns clean, readable content for a URL via Tavily's Extract
 * endpoint — used by the WebViewer "Reader view" fallback when a page cannot be
 * embedded in the in-app iframe (X-Frame-Options / CSP) or is a PDF.
 *
 * Response: { url, title, html, markdown } where `html` is sanitized and safe
 * to inject via dangerouslySetInnerHTML.
 */

interface ExtractPayload {
  url: string;
  title: string;
  html: string;
  markdown: string;
}

async function handle(rawUrl: string): Promise<NextResponse> {
  const url = rawUrl.trim();
  if (!url) return NextResponse.json({ error: "Missing url" }, { status: 400 });

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return NextResponse.json({ error: "Invalid url" }, { status: 400 });
  }

  // SSRF guard: never let Tavily-bound input double as a vector to our own
  // network. (Tavily fetches remotely, but we still refuse private/oauth hosts
  // to keep behavior consistent with /api/proxy.)
  if (isBlockedUrl(url)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  try {
    const result = await tavilyExtractOne(url, { extractDepth: "advanced", format: "markdown" });
    const markdown = result.raw_content ?? "";
    const title = deriveTitle(markdown, parsed);
    const html = markdownToSafeHtml(markdown);

    const payload: ExtractPayload = { url, title, html, markdown };
    return NextResponse.json(payload, {
      headers: { "Cache-Control": "private, max-age=300" },
    });
  } catch (err) {
    if (err instanceof TavilyError) {
      // 503 (no key) / 502 (network) / 4xx (no content) — surface as 502 to the
      // client so it can fall back to the "open original" escape hatch, but keep
      // the real status for observability.
      const status = err.status === 503 ? 503 : 502;
      return NextResponse.json({ error: err.message }, { status });
    }
    const msg = err instanceof Error ? err.message : "Extraction failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}

export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return handle(req.nextUrl.searchParams.get("url") ?? "");
}

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let url = "";
  try {
    const body = await req.json();
    url = typeof body?.url === "string" ? body.url : "";
  } catch {
    url = req.nextUrl.searchParams.get("url") ?? "";
  }
  return handle(url);
}

/** First markdown H1/H2, else first non-empty line, else the hostname. */
function deriveTitle(markdown: string, parsed: URL): string {
  const heading = markdown.match(/^\s{0,3}#{1,2}\s+(.+?)\s*$/m);
  if (heading?.[1]) return clean(heading[1]).slice(0, 160);
  const firstLine = markdown.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  if (firstLine) return clean(firstLine).slice(0, 160);
  return parsed.hostname.replace(/^www\./, "");
}

function clean(s: string): string {
  return s
    .replace(/[#*_`>[\]()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Minimal, dependency-free markdown → HTML converter for reader content, then
 * sanitized with DOMPurify. We only support the subset Tavily emits (headings,
 * paragraphs, lists, links, images, bold/italic, code, blockquotes, hr). Output
 * is sanitized regardless, so an imperfect converter can't introduce XSS.
 */
function markdownToSafeHtml(md: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Inline: links, images, bold, italic, code. Operates on already-escaped text.
  const inline = (text: string): string =>
    text
      .replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_m, alt, src) =>
        /^https?:\/\//i.test(src) ? `<img src="${src}" alt="${alt}" loading="lazy" />` : esc(alt))
      .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_m, label, href) =>
        /^https?:\/\//i.test(href) ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>` : label)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");

  const lines = esc(md).split(/\r?\n/);
  const out: string[] = [];
  let listType: "ul" | "ol" | null = null;
  let para: string[] = [];

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inline(para.join(" ").trim())}</p>`);
      para = [];
    }
  };
  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) { flushPara(); closeList(); continue; }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flushPara(); closeList(); const lvl = h[1].length; out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`); continue; }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { flushPara(); closeList(); out.push("<hr />"); continue; }

    if (/^\s*>\s?/.test(line)) { flushPara(); closeList(); out.push(`<blockquote>${inline(line.replace(/^\s*>\s?/, ""))}</blockquote>`); continue; }

    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      const want: "ul" | "ol" = ul ? "ul" : "ol";
      if (listType !== want) { closeList(); listType = want; out.push(`<${want}>`); }
      out.push(`<li>${inline((ul ? ul[1] : ol![1]))}</li>`);
      continue;
    }

    closeList();
    para.push(line.trim());
  }
  flushPara();
  closeList();

  const html = out.join("\n");
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      "p", "br", "hr", "a", "img", "strong", "em", "code", "pre", "blockquote",
      "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6", "table", "thead",
      "tbody", "tr", "th", "td",
    ],
    ALLOWED_ATTR: ["href", "src", "alt", "title", "target", "rel", "loading"],
    ALLOW_DATA_ATTR: false,
  });
}
