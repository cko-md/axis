// Composio-backed Mail accounts — the reference domain for the Composio
// foundation (src/lib/integrations/composio.ts). Lives alongside gmail.ts /
// outlook.ts (the legacy direct-OAuth path) and is additive: accounts
// connected this way show up next to legacy OAuth accounts in the same
// inbox, distinguished only by an internal `via` tag the UI never sees.
//
// NOTE: exact Gmail/Outlook tool response field names below are mapped
// defensively (multiple plausible keys tried) because they have not been
// confirmed against a live connected account — completing a real Gmail/
// Outlook OAuth grant via Composio is a user step (see plan). Input argument
// schemas ARE confirmed live against Composio's /tools/{slug} endpoint.
import { createClient } from "@/lib/supabase/server";
import { executeTool, ComposioError } from "@/lib/integrations/composio";
import { extractBody, type GmailPayload, type MailMessage, type MailMessageFull } from "./gmail";

// Profile/email resolution for ACTIVE connections now lives in the shared
// integrations/composio.ts (resolveProfileLabel) since Calendar and Contacts
// need the same concept — see that file for gmail/outlook tool slugs.
type MailToolkit = "gmail" | "outlook";
const LIST_TOOL: Record<MailToolkit, string> = {
  gmail: "GMAIL_FETCH_EMAILS",
  outlook: "OUTLOOK_OUTLOOK_LIST_MESSAGES",
};
const SEND_TOOL: Record<MailToolkit, string> = {
  gmail: "GMAIL_SEND_EMAIL",
  outlook: "OUTLOOK_OUTLOOK_SEND_EMAIL",
};
// Single-message fetch tools. Best-effort slugs (Gmail's single-message fetch
// and Outlook's get-message) — NOT yet confirmed against a live connected
// account, mapped defensively like the list normalizers above. A wrong slug
// surfaces as a structured `provider_error` the UI shows, which is strictly
// better than the previous behavior (the message detail route had no Composio
// branch at all, so Composio rows 404'd silently). Verify on first live test.
const GET_TOOL: Record<MailToolkit, string> = {
  gmail: "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
  outlook: "OUTLOOK_OUTLOOK_GET_MESSAGE",
};

export type ComposioMailAccount = {
  provider: "gmail" | "outlook";
  mailEmail: string;
  via: "composio";
  connectedAccountId: string;
};

export async function listComposioMailAccounts(userId: string): Promise<ComposioMailAccount[]> {
  const supabase = await createClient();
  // Don't gate message listing on account_label being resolved — the label is
  // cosmetic (filled lazily by the status route) and requiring it left a
  // freshly-connected, ACTIVE inbox showing no mail until that round-trip
  // landed. List as soon as ACTIVE; fall back to a generic label.
  const { data } = await supabase
    .from("composio_connections")
    .select("toolkit, connected_account_id, account_label")
    .eq("user_id", userId)
    .eq("status", "ACTIVE")
    .in("toolkit", ["gmail", "outlook"]);

  return (data ?? []).map((row) => ({
    provider: row.toolkit as "gmail" | "outlook",
    mailEmail: (row.account_label as string | null) ?? "Connected account",
    via: "composio" as const,
    connectedAccountId: row.connected_account_id as string,
  }));
}

function gmailHeader(headers: unknown, name: string): string {
  if (!Array.isArray(headers)) return "";
  const h = headers.find(
    (x) => typeof x?.name === "string" && x.name.toLowerCase() === name.toLowerCase(),
  );
  return typeof h?.value === "string" ? h.value : "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function unwrapMessageRecord(data: Record<string, unknown>): Record<string, unknown> {
  const candidates = [
    data.message,
    data.email,
    data.data,
    data.result,
    data.response_data,
    data.responseData,
    data.payload,
    data,
  ];

  for (const candidate of candidates) {
    const first = Array.isArray(candidate) ? candidate[0] : candidate;
    const record = asRecord(first);
    if (record) return record;
  }

  return data;
}

function looksLikeHtml(value: string): boolean {
  return /<\/?[a-z][\s\S]*>/i.test(value);
}

function extractProviderBody(m: Record<string, unknown>): { body: string; bodyIsHtml: boolean } {
  const bodyObj = asRecord(m.body);
  if (bodyObj) {
    const content = stringField(bodyObj, ["content", "body", "value"]);
    if (content) {
      const contentType = stringField(bodyObj, ["contentType", "content_type", "mimeType", "mime_type"]) ?? "";
      return { body: content, bodyIsHtml: contentType.toLowerCase().includes("html") || looksLikeHtml(content) };
    }
  }

  const html = stringField(m, [
    "messageHtml",
    "bodyHtml",
    "htmlBody",
    "body_html",
    "html",
    "renderedBody",
  ]);
  if (html) return { body: html, bodyIsHtml: true };

  const genericBody = stringField(m, ["body", "message", "content"]);
  if (genericBody) return { body: genericBody, bodyIsHtml: looksLikeHtml(genericBody) };

  const text = stringField(m, [
    "messageText",
    "bodyText",
    "plainText",
    "textBody",
    "body_text",
    "text",
    "snippet",
    "bodyPreview",
  ]);
  return { body: text ?? "", bodyIsHtml: false };
}

// Normalizes a single Gmail-toolkit message into the same MailMessage shape
// gmail.ts produces, trying both the raw Gmail API resource shape (payload/
// headers/labelIds — Composio's Gmail tools are documented to stay close to
// the native API) and Composio's flattened convenience fields as a fallback.
export function normalizeGmailMessage(m: Record<string, unknown>, accountEmail: string): MailMessage | null {
  const id = (m.id ?? m.messageId) as string | undefined;
  if (!id) return null;
  const headers = (m.payload as Record<string, unknown> | undefined)?.headers;
  return {
    id,
    threadId: (m.threadId as string) ?? id,
    from: gmailHeader(headers, "From") || (m.sender as string) || (m.from as string) || "",
    subject: gmailHeader(headers, "Subject") || (m.subject as string) || "(no subject)",
    date: gmailHeader(headers, "Date") || (m.messageTimestamp as string) || (m.date as string) || "",
    snippet: (m.snippet as string) ?? (m.messageText as string)?.slice(0, 200) ?? "",
    isUnread: Array.isArray(m.labelIds) ? (m.labelIds as string[]).includes("UNREAD") : false,
    provider: "gmail",
    accountEmail,
  };
}

export function normalizeOutlookMessage(m: Record<string, unknown>, accountEmail: string): MailMessage | null {
  const id = m.id as string | undefined;
  if (!id) return null;
  const from = m.from as { emailAddress?: { name?: string; address?: string } } | undefined;
  const sender = from?.emailAddress;
  return {
    id,
    threadId: (m.conversationId as string) ?? id,
    from: sender ? (sender.name ? `${sender.name} <${sender.address}>` : sender.address ?? "") : "",
    subject: (m.subject as string) || "(no subject)",
    date: (m.receivedDateTime as string) ?? "",
    snippet: (m.bodyPreview as string) ?? "",
    isUnread: m.isRead === false,
    provider: "outlook",
    accountEmail,
  };
}

// ── Full-message normalizers (header normalization reused; body added) ────────

export function normalizeGmailMessageFull(m: Record<string, unknown>, accountEmail: string): MailMessageFull | null {
  const base = normalizeGmailMessage(m, accountEmail);
  if (!base) return null;
  // Prefer the native payload shape (same as the direct Gmail adapter); fall
  // back to Composio's flattened convenience fields and body objects.
  const payload = m.payload as GmailPayload | undefined;
  let body = "";
  let bodyIsHtml = false;
  if (payload) {
    const extracted = extractBody(payload);
    body = extracted.content;
    bodyIsHtml = extracted.isHtml;
  }
  if (!body) {
    const extracted = extractProviderBody(m);
    body = extracted.body;
    bodyIsHtml = extracted.bodyIsHtml;
  }
  return { ...base, body, bodyIsHtml };
}

export function normalizeOutlookMessageFull(m: Record<string, unknown>, accountEmail: string): MailMessageFull | null {
  const base = normalizeOutlookMessage(m, accountEmail);
  if (!base) return null;
  const { body, bodyIsHtml } = extractProviderBody(m);
  return { ...base, body, bodyIsHtml };
}

/**
 * Fetch a single message's full body via Composio. Throws ComposioError on
 * provider failure (the adapter wraps it into a structured Result); returns
 * null only when the message genuinely isn't found / can't be normalized.
 */
export async function getComposioMessage(
  toolkit: MailToolkit,
  connectedAccountId: string,
  userId: string,
  messageId: string,
  accountEmail: string,
): Promise<MailMessageFull | null> {
  const res = await executeTool({
    toolSlug: GET_TOOL[toolkit],
    connectedAccountId,
    userId,
    arguments:
      toolkit === "gmail"
        ? { message_id: messageId, user_id: "me", format: "full" }
        : { message_id: messageId },
  });
  if (!res.successful) {
    throw new ComposioError(res.error ?? `${toolkit} get-message failed`, 502);
  }
  // Tools may return the message at the top level or nested under data/message.
  const data = res.data as Record<string, unknown>;
  const raw = unwrapMessageRecord(data);
  return toolkit === "gmail"
    ? normalizeGmailMessageFull(raw, accountEmail)
    : normalizeOutlookMessageFull(raw, accountEmail);
}

export async function listComposioInbox(
  toolkit: MailToolkit,
  connectedAccountId: string,
  userId: string,
  accountEmail: string,
): Promise<MailMessage[]> {
  const res = await executeTool({
    toolSlug: LIST_TOOL[toolkit],
    connectedAccountId,
    userId,
    arguments:
      toolkit === "gmail"
        ? { max_results: 20, include_payload: true, label_ids: ["INBOX"] }
        : { top: 20, folder: "Inbox", orderby: ["receivedDateTime desc"] },
  });
  if (!res.successful) return [];

  const data = res.data as Record<string, unknown>;
  const rawMessages = (data.messages ?? data.value ?? []) as Record<string, unknown>[];
  const normalize = toolkit === "gmail" ? normalizeGmailMessage : normalizeOutlookMessage;
  return rawMessages
    .map((m) => normalize(m, accountEmail))
    .filter((m): m is MailMessage => m !== null);
}

export async function sendComposioMail(
  toolkit: MailToolkit,
  connectedAccountId: string,
  userId: string,
  to: string,
  subject: string,
  body: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await executeTool({
    toolSlug: SEND_TOOL[toolkit],
    connectedAccountId,
    userId,
    arguments:
      toolkit === "gmail"
        ? { recipient_email: to, subject, body }
        : { to_email: to, subject, body },
  });
  return res.successful ? { ok: true } : { ok: false, error: res.error ?? "Send failed" };
}
