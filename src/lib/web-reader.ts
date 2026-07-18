import DOMPurify from "isomorphic-dompurify";

// jsdom and @mozilla/readability are imported lazily inside the function so this
// module can be evaluated at build time (Next.js "collect page data") without
// eagerly loading jsdom's filesystem assets (default-stylesheet.css), which
// breaks the server bundle. They load on first request instead.

export type ReaderArticle = {
  title: string;
  html: string;
  excerpt: string | null;
  byline: string | null;
  siteName: string | null;
};

const ALLOWED_TAGS = [
  "p", "br", "hr", "a", "img", "strong", "em", "code", "pre", "blockquote",
  "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6", "table", "thead",
  "tbody", "tr", "th", "td", "figure", "figcaption",
];

export async function extractReadableArticle(html: string, url: string): Promise<ReaderArticle | null> {
  const { JSDOM } = await import("jsdom");
  const { Readability } = await import("@mozilla/readability");

  const dom = new JSDOM(html, { url });
  const parsed = new Readability(dom.window.document, {
    maxElemsToParse: 50_000,
  }).parse();

  if (!parsed?.content || (parsed.textContent ?? "").trim().length < 80) return null;

  const cleanHtml = DOMPurify.sanitize(parsed.content, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ["href", "src", "alt", "title", "target", "rel", "loading"],
    ALLOW_DATA_ATTR: false,
  });

  if (!cleanHtml.trim()) return null;

  return {
    title: parsed.title?.trim() || new URL(url).hostname.replace(/^www\./, ""),
    html: cleanHtml,
    excerpt: parsed.excerpt?.trim() || null,
    byline: parsed.byline?.trim() || null,
    siteName: parsed.siteName?.trim() || null,
  };
}
