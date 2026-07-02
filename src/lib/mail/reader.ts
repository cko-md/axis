import DOMPurify from "isomorphic-dompurify";
import { parseMailDate } from "@/lib/mail/dates";

// Pure helpers for the Mail document reader (MessagePanel + inbox rows).
// Kept out of the component so sanitization and formatting stay unit-testable.

// Email bodies come straight from Gmail/Outlook senders and are fully
// attacker-controlled — sanitize before ever touching innerHTML. Scripts,
// event handlers, iframes, objects, and forms are stripped; safe formatting
// tags (links, tables, images) pass through.
export function sanitizeMailHtml(html: string, allowExternalContent: boolean): string {
  const sanitized = DOMPurify.sanitize(html, {
    FORBID_TAGS: [
      "script",
      "style",
      "iframe",
      "object",
      "embed",
      "form",
      "link",
      "meta",
      "base",
      ...(allowExternalContent ? [] : ["img", "picture", "source"]),
    ],
    FORBID_ATTR: [
      "onerror",
      "onload",
      "onclick",
      "onmouseover",
      "onfocus",
      "onblur",
      "srcdoc",
      "formaction",
      ...(allowExternalContent ? [] : ["src", "srcset", "background"]),
    ],
    ADD_ATTR: ["target", "rel", "referrerpolicy", "loading", "decoding", "srcset", "sizes"],
    ALLOW_DATA_ATTR: false,
  });
  return sanitized.replace(/<a\b([^>]*)>/gi, (_match, attrs: string) => {
    const safeAttrs = attrs
      .replace(/\s(?:target|rel)=("[^"]*"|'[^']*'|[^\s>]*)/gi, "")
      .trim();
    return `<a${safeAttrs ? ` ${safeAttrs}` : ""} target="_blank" rel="noopener noreferrer">`;
  });
}

export function stripMailHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function formatAttachmentSize(sizeBytes?: number | null): string {
  if (!sizeBytes || sizeBytes <= 0) return "Unknown size";
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function attachmentKind(mimeType: string): string {
  const type = mimeType.toLowerCase();
  if (type.includes("pdf")) return "PDF";
  if (type.startsWith("image/")) return "Image";
  if (type.includes("spreadsheet") || type.includes("excel")) return "Sheet";
  if (type.includes("presentation") || type.includes("powerpoint")) return "Deck";
  if (type.includes("word") || type.includes("document")) return "Doc";
  return "File";
}

export function replySubject(subject: string): string {
  return /^re\s*:/i.test(subject) ? subject : `Re: ${subject}`;
}

export function replyAddress(from: string): string {
  const fromMatch = from.match(/<([^>]+)>/);
  return (fromMatch ? fromMatch[1] : from).trim();
}

export type SenderParts = { name: string; email: string };

// "Jane Poe <jane@example.com>" → { name: "Jane Poe", email: "jane@example.com" };
// bare addresses fall back to the address for both parts.
export function parseSenderParts(from: string): SenderParts {
  const email = replyAddress(from).replace(/^"|"$/g, "");
  const nameMatch = from.match(/^([^<]+)</);
  const name = (nameMatch ? nameMatch[1] : from.replace(/<[^>]+>/, ""))
    .replace(/^["'\s]+|["'\s]+$/g, "")
    .trim();
  return { name: name || email, email };
}

export function senderInitials(from: string): string {
  const { name, email } = parseSenderParts(from);
  const source = name && name !== email ? name : email.split("@")[0];
  const words = source
    .split(/[\s._-]+/)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

export const SENDER_TONES = ["gold", "marine", "clay", "up"] as const;
export type SenderTone = (typeof SENDER_TONES)[number];

// Deterministic accent tone per sender so an avatar keeps its color across
// renders and sessions without storing anything.
export function senderTone(from: string): SenderTone {
  const { email } = parseSenderParts(from);
  let hash = 0;
  for (let i = 0; i < email.length; i += 1) {
    hash = (hash * 31 + email.charCodeAt(i)) >>> 0;
  }
  return SENDER_TONES[hash % SENDER_TONES.length];
}

// Full explicit timestamp for the document header ("Wed, Jul 2, 2026, 3:41 PM").
// The inbox list keeps relative dates; the reader states the real moment.
export function formatMessageTimestamp(dateStr: string): string {
  const date = parseMailDate(dateStr);
  if (!date) return "Unknown date";
  return date.toLocaleString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export type ReaderScale = "compact" | "comfortable" | "large";

export const READER_SCALES: Record<ReaderScale, { label: string; htmlPx: number; plainPx: number }> = {
  compact: { label: "Compact text", htmlPx: 13, plainPx: 12.5 },
  comfortable: { label: "Comfortable text", htmlPx: 14.5, plainPx: 14 },
  large: { label: "Large text", htmlPx: 16.5, plainPx: 16 },
};

export const DEFAULT_READER_SCALE: ReaderScale = "comfortable";

const READER_SCALE_ORDER: ReaderScale[] = ["compact", "comfortable", "large"];

export function nextReaderScale(current: ReaderScale): ReaderScale {
  const index = READER_SCALE_ORDER.indexOf(current);
  return READER_SCALE_ORDER[(index + 1) % READER_SCALE_ORDER.length];
}

export function isReaderScale(value: unknown): value is ReaderScale {
  return typeof value === "string" && value in READER_SCALES;
}

// Device-level display preference (like theme choice) — not user data, so
// localStorage is the right home; nothing falls back here instead of Supabase.
const READER_SCALE_KEY = "axis-mail-reader-scale";

export function loadReaderScale(): ReaderScale {
  if (typeof window === "undefined") return DEFAULT_READER_SCALE;
  try {
    const stored = window.localStorage.getItem(READER_SCALE_KEY);
    return isReaderScale(stored) ? stored : DEFAULT_READER_SCALE;
  } catch {
    return DEFAULT_READER_SCALE;
  }
}

// Keyboard shortcuts for the mail list + reader. Pure key → intent mapping so
// the component handler stays a thin dispatcher and the map is unit-testable.
export type MailShortcut = "next" | "prev" | "open" | "close" | "search";

export function mailShortcutForKey(key: string): MailShortcut | null {
  switch (key) {
    case "j":
    case "ArrowDown":
      return "next";
    case "k":
    case "ArrowUp":
      return "prev";
    case "Enter":
    case "o":
      return "open";
    case "Escape":
      return "close";
    case "/":
      return "search";
    default:
      return null;
  }
}

// Shortcuts must never fire while the user is typing in a field.
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

export function saveReaderScale(scale: ReaderScale): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(READER_SCALE_KEY, scale);
  } catch {
    // Storage may be unavailable (private mode); the preference just resets.
  }
}
