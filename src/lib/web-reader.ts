import DOMPurify from "isomorphic-dompurify";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

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

export function extractReadableArticle(html: string, url: string): ReaderArticle | null {
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
