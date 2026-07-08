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
import { GMAIL_COMPOSIO_TOOLS, OUTLOOK_COMPOSIO_TOOLS } from "@/lib/integrations/composio-mail-tools";
import { extractBody, extractGmailAttachments, type GmailPayload, type MailAttachment, type MailMessage, type MailMessageFull } from "./gmail";
import { normalizeMailDate } from "./dates";

// Profile/email resolution for ACTIVE connections now lives in the shared
// integrations/composio.ts (resolveProfileLabel) since Calendar and Contacts
// need the same concept — see that file for gmail/outlook tool slugs.
type MailToolkit = "gmail" | "outlook";
const LIST_TOOL: Record<MailToolkit, string> = {
  gmail: GMAIL_COMPOSIO_TOOLS[0],
  outlook: OUTLOOK_COMPOSIO_TOOLS[0],
};
const SEND_TOOL: Record<MailToolkit, string> = {
  gmail: GMAIL_COMPOSIO_TOOLS[2],
  outlook: OUTLOOK_COMPOSIO_TOOLS[2],
};
// Single-message fetch tools verified via Composio's tools API.
// Gmail: GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID — GMAIL_GET_MESSAGE does not exist.
// Outlook: OUTLOOK_GET_MESSAGE (replaces invalid OUTLOOK_OUTLOOK_GET_MESSAGE).
export const GMAIL_GET_MESSAGE_TOOL = GMAIL_COMPOSIO_TOOLS[1];
export const OUTLOOK_GET_MESSAGE_TOOL = OUTLOOK_COMPOSIO_TOOLS[1];
const GET_TOOL: Record<MailToolkit, readonly string[]> = {
  gmail: [GMAIL_GET_MESSAGE_TOOL],
  outlook: [OUTLOOK_GET_MESSAGE_TOOL],
};
const GMAIL_MODIFY_LABELS_TOOL = "GMAIL_ADD_LABEL_TO_EMAIL";
const GMAIL_MOVE_TO_TRASH_TOOL = "GMAIL_MOVE_TO_TRASH";

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
  const { data, error } = await supabase
    .from("composio_connections")
    .select("toolkit, connected_account_id, account_label")
    .eq("user_id", userId)
    .eq("status", "ACTIVE")
    .in("toolkit", ["gmail", "outlook"]);
  if (error) throw error;

  return (data ?? []).map((row) => ({
    provider: row.toolkit as "gmail" | "outlook",
    mailEmail: (row.account_label as string | null) ?? "Connected account",
    via: "composio" as const,
    connectedAccountId: row.connected_account_id as string,
  }));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function gmailHeader(headers: unknown, name: string): string {
  if (Array.isArray(headers)) {
    const headerName = name.toLowerCase();
    const match = headers.find((header) => {
      const row = asRecord(header);
      const rowName = row?.name;
      return typeof rowName === "string" && rowName.toLowerCase() === headerName;
    });
    const matchRow = asRecord(match);
    const value = matchRow?.value;
    if (typeof value === "string") return value;
    const nested = asRecord(value)?.value;
    return typeof nested === "string" ? nested : "";
  }

  const headerMap = asRecord(headers);
  if (!headerMap) return "";
  const headerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headerMap)) {
    if (key.toLowerCase() !== headerName) continue;
    if (typeof value === "string") return value;
    const nested = asRecord(value);
    if (typeof nested?.value === "string") return nested.value;
  }
  return "";
}

function stringField(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function unwrapMessageRecord(data: Record<string, unknown>): Record<string, unknown> {
  const nestedResults = Array.isArray(data.results) ? data.results[0] : undefined;
  const nestedResponse = asRecord(nestedResults)?.response;

  const candidates = [
    data.message,
    data.email,
    data.data,
    data.result,
    data.response_data,
    data.responseData,
    data.payload,
    data.output,
    data.response,
    data.data_preview,
    nestedResponse,
    asRecord(nestedResponse)?.data,
    asRecord(data.data)?.data,
    data,
  ];

  for (const candidate of candidates) {
    const first = Array.isArray(candidate) ? candidate[0] : candidate;
    const record = asRecord(first);
    if (record && (record.id || record.messageId)) return record;
  }

  for (const candidate of candidates) {
    const first = Array.isArray(candidate) ? candidate[0] : candidate;
    const record = asRecord(first);
    if (record) return record;
  }

  return data;
}

function extractGmailHeaders(m: Record<string, unknown>): unknown {
  const nestedPayload = asRecord(m.payload) ?? asRecord(asRecord(m.data)?.payload);
  return (
    nestedPayload?.headers ??
    asRecord(m.gmailPayload)?.headers ??
    asRecord(m.gmail_payload)?.headers ??
    asRecord(m.messagePayload)?.headers ??
    asRecord(m.message_payload)?.headers ??
    m.headers ??
    m.payloadHeaders ??
    m.payload_headers ??
    []
  );
}

function extractGmailPayload(m: Record<string, unknown>): GmailPayload | null {
  const candidates = [
    m.payload,
    m.gmailPayload,
    m.gmail_payload,
    m.messagePayload,
    m.message_payload,
    m.rawPayload,
    m.raw_payload,
    asRecord(m.message)?.payload,
    asRecord(m.data)?.payload,
  ];
  for (const candidate of candidates) {
    const payload = asRecord(candidate);
    if (!payload) continue;
    if (payload.parts || payload.body || payload.headers || payload.mimeType || payload.mime_type) {
      return payload as GmailPayload;
    }
  }
  return null;
}

// Verified against Composio's live tool schema (2026-07-08):
// GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID takes { message_id (required),
// user_id (default "me"), format (default "full") }. A single canonical
// argument shape — the previous shotgun of five variants meant a genuine
// provider failure was retried four more times with known-wrong argument
// names, multiplying latency and masking the real error.
function gmailGetMessageArguments(messageId: string): Record<string, unknown>[] {
  return [{ message_id: messageId, user_id: "me", format: "full" }];
}

function outlookGetMessageArguments(messageId: string): Record<string, unknown>[] {
  return [
    { message_id: messageId, user_id: "me" },
  ];
}

function buildGmailSendArguments(to: string, subject: string, body: string): Record<string, unknown> {
  return {
    recipient_email: to,
    subject,
    body,
    user_id: "me",
    is_html: looksLikeHtml(body),
  };
}

function buildOutlookSendArguments(to: string, subject: string, body: string): Record<string, unknown> {
  return {
    to,
    subject,
    body,
    user_id: "me",
    is_html: looksLikeHtml(body),
    save_to_sent_items: true,
  };
}

function looksLikeHtml(value: string): boolean {
  return /<\/?[a-z][\s\S]*>/i.test(value);
}

function extractProviderBody(m: Record<string, unknown>): { body: string; bodyIsHtml: boolean } {
  const bodyObj = asRecord(m.body);
  if (bodyObj) {
    const content = stringField(bodyObj, ["content", "body", "value", "data"]);
    if (content) {
      const contentType = stringField(bodyObj, ["contentType", "content_type", "mimeType", "mime_type"]) ?? "";
      return { body: content, bodyIsHtml: contentType.toLowerCase().includes("html") || looksLikeHtml(content) };
    }
  }

  const html = stringField(m, [
    "messageHtml",
    "message_html",
    "bodyHtml",
    "htmlBody",
    "body_html",
    "html_body",
    "html",
    "renderedBody",
    "rendered_body",
    "htmlContent",
  ]);
  if (html) return { body: html, bodyIsHtml: true };

  const genericBody = stringField(m, ["body", "message", "content"]);
  if (genericBody) return { body: genericBody, bodyIsHtml: looksLikeHtml(genericBody) };

  const text = stringField(m, [
    "messageText",
    "message_text",
    "bodyText",
    "plainText",
    "plain_text",
    "textBody",
    "body_text",
    "text_body",
    "text",
    "snippet",
    "bodyPreview",
    "body_preview",
    "plainContent",
  ]);
  return { body: text ?? "", bodyIsHtml: false };
}

function numberField(source: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function extractGenericAttachments(m: Record<string, unknown>): MailAttachment[] {
  // `attachmentList` is the field Composio's Gmail tools document for the
  // flattened response shape; the rest cover other providers/tool versions.
  const raw =
    m.attachmentList ?? m.attachment_list ?? m.attachments ?? m.attachment ?? m.files ?? m.fileAttachments;
  const list = Array.isArray(raw) ? raw : [];

  return list.flatMap((item, index) => {
    const attachment = asRecord(item);
    if (!attachment) return [];

    const filename = stringField(attachment, ["filename", "fileName", "name", "displayName"]);
    if (!filename) return [];

    const id =
      stringField(attachment, ["id", "attachmentId", "attachment_id", "contentId"]) ??
      `${filename}:${index}`;

    return [{
      id,
      filename,
      mimeType:
        stringField(attachment, ["mimeType", "mime_type", "contentType", "content_type"]) ??
        "application/octet-stream",
      sizeBytes: numberField(attachment, ["size", "sizeBytes", "size_bytes"]),
      inline: attachment.isInline === true || attachment.inline === true,
    }];
  });
}

// Normalizes a single Gmail-toolkit message into the same MailMessage shape
// gmail.ts produces, trying both the raw Gmail API resource shape (payload/
// headers/labelIds — Composio's Gmail tools are documented to stay close to
// the native API) and Composio's flattened convenience fields as a fallback.
// Sender fallback when no From header is present. Composio's flattened Gmail
// shape uses a `sender` string; some tool versions return `from` as an object
// ({ name, email }) instead of a string — never render "[object Object]".
function gmailFromField(m: Record<string, unknown>): string {
  if (typeof m.sender === "string" && m.sender.trim()) return m.sender;
  if (typeof m.from === "string" && m.from.trim()) return m.from;
  const from = asRecord(m.from);
  if (from) {
    const email = stringField(from, ["email", "address", "emailAddress"]);
    const name = stringField(from, ["name", "displayName"]);
    if (email) return name ? `${name} <${email}>` : email;
    if (name) return name;
  }
  return "";
}

function gmailSnippet(m: Record<string, unknown>): string {
  if (typeof m.snippet === "string") return m.snippet;
  // Composio's flattened Gmail shape carries the plain-text preview in
  // `preview.body` (object) or `messageText` (full decoded text/plain part).
  const preview = asRecord(m.preview);
  if (preview && typeof preview.body === "string") return preview.body.slice(0, 200);
  if (typeof m.messageText === "string") return m.messageText.slice(0, 200);
  return "";
}

export function normalizeGmailMessage(
  m: Record<string, unknown>,
  accountEmail: string,
  connectedAccountId?: string,
): MailMessage | null {
  const id = (m.id ?? m.messageId) as string | undefined;
  if (!id) return null;
  const headers = extractGmailHeaders(m);
  return {
    id,
    threadId: (m.threadId as string) ?? id,
    from: gmailHeader(headers, "From") || gmailFromField(m),
    subject: gmailHeader(headers, "Subject") || (m.subject as string) || "(no subject)",
    date: normalizeMailDate(
      gmailHeader(headers, "Date") ||
        m.messageTimestamp ||
        m.internalDate ||
        m.receivedDateTime ||
        m.date,
    ),
    snippet: gmailSnippet(m),
    isUnread: Array.isArray(m.labelIds) ? (m.labelIds as string[]).includes("UNREAD") : false,
    provider: "gmail",
    accountEmail,
    ...(connectedAccountId ? { connectedAccountId } : {}),
  };
}

export function normalizeOutlookMessage(
  m: Record<string, unknown>,
  accountEmail: string,
  connectedAccountId?: string,
): MailMessage | null {
  const id = m.id as string | undefined;
  if (!id) return null;
  const from = m.from as { emailAddress?: { name?: string; address?: string } } | undefined;
  const sender = from?.emailAddress;
  return {
    id,
    threadId: (m.conversationId as string) ?? id,
    from: sender ? (sender.name ? `${sender.name} <${sender.address}>` : sender.address ?? "") : "",
    subject: (m.subject as string) || "(no subject)",
    date: normalizeMailDate(m.receivedDateTime ?? m.sentDateTime ?? m.createdDateTime ?? m.date),
    snippet: (m.bodyPreview as string) ?? "",
    isUnread: m.isRead === false,
    provider: "outlook",
    accountEmail,
    ...(connectedAccountId ? { connectedAccountId } : {}),
  };
}

// ── Full-message normalizers (header normalization reused; body added) ────────

export function normalizeGmailMessageFull(
  m: Record<string, unknown>,
  accountEmail: string,
  connectedAccountId?: string,
): MailMessageFull | null {
  const base = normalizeGmailMessage(m, accountEmail, connectedAccountId);
  if (!base) return null;
  // Prefer the native payload shape (same as the direct Gmail adapter); fall
  // back to Composio's flattened convenience fields and body objects.
  const payload = extractGmailPayload(m);
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
  // Attachments: prefer the native payload parts, but fall back to Composio's
  // flattened `attachmentList` — some responses include a payload without
  // attachment parts while still listing attachments at the top level.
  const payloadAttachments = payload ? extractGmailAttachments(payload) : [];
  const attachments = payloadAttachments.length > 0 ? payloadAttachments : extractGenericAttachments(m);
  return { ...base, body, bodyIsHtml, attachments };
}

export function normalizeOutlookMessageFull(
  m: Record<string, unknown>,
  accountEmail: string,
  connectedAccountId?: string,
): MailMessageFull | null {
  const base = normalizeOutlookMessage(m, accountEmail, connectedAccountId);
  if (!base) return null;
  const { body, bodyIsHtml } = extractProviderBody(m);
  return { ...base, body, bodyIsHtml, attachments: extractGenericAttachments(m) };
}

// Map a Composio tool-execution error string onto the most defensible HTTP
// status, so the adapter's failFromException produces the right normalized
// code: genuine not-found → 404 (`not_found`, not captured to Sentry as 5xx),
// auth failures → 401 (`auth_expired` → reconnect prompt), throttling → 429
// (`rate_limited` → retryable), anything else stays 502 (`provider_error`).
// Matches are deliberately narrow — an unrecognized message keeps 502.
// A Composio "tool … not found" (bad slug — a config bug, not a missing
// message) must NOT map onto 404; only entity/message not-found does.
export function composioMailErrorStatus(error: string): number {
  const msg = error.toLowerCase();
  if (/requested entity was not found|(?:message|email) (?:was )?not found|\b404\b/.test(msg)) return 404;
  if (/\bunauthorized\b|invalid credentials|invalid_grant|token (?:has been )?(?:expired|revoked)|\b401\b/.test(msg)) return 401;
  if (/rate limit|too many requests|\b429\b/.test(msg)) return 429;
  return 502;
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
  const toolSlugs = GET_TOOL[toolkit];
  const argVariants = toolkit === "gmail" ? gmailGetMessageArguments(messageId) : outlookGetMessageArguments(messageId);
  const normalize = toolkit === "gmail" ? normalizeGmailMessageFull : normalizeOutlookMessageFull;

  let lastError: string | null = null;
  for (const toolSlug of toolSlugs) {
    for (const args of argVariants) {
      const res = await executeTool({
        toolSlug,
        connectedAccountId,
        userId,
        arguments: args,
      });
      if (!res.successful) {
        lastError = res.error ?? `${toolkit} get-message failed`;
        continue;
      }
      const data = res.data as Record<string, unknown>;
      const raw = unwrapMessageRecord(data);
      const message = normalize(raw, accountEmail, connectedAccountId);
      if (message) return message;
    }
  }

  if (lastError) {
    throw new ComposioError(lastError, composioMailErrorStatus(lastError));
  }
  return null;
}

export async function listComposioInbox(
  toolkit: MailToolkit,
  connectedAccountId: string,
  userId: string,
  accountEmail: string,
  opts?: { pageToken?: string; skip?: number },
): Promise<{ messages: MailMessage[]; nextPageToken?: string; hasMore?: boolean }> {
  const res = await executeTool({
    toolSlug: LIST_TOOL[toolkit],
    connectedAccountId,
    userId,
    arguments:
      toolkit === "gmail"
        ? {
            max_results: 20,
            include_payload: true,
            label_ids: ["INBOX"],
            ...(opts?.pageToken ? { page_token: opts.pageToken } : {}),
          }
        : {
            top: 20,
            folder: "inbox",
            orderby: ["receivedDateTime desc"],
            ...(opts?.skip ? { skip: opts.skip } : {}),
          },
  });
  if (!res.successful) {
    throw new ComposioError(res.error ?? `${toolkit} inbox list failed`, 502);
  }

  const data = res.data as Record<string, unknown>;
  const rawMessages = (data.messages ?? data.value ?? []) as Record<string, unknown>[];
  const normalize = toolkit === "gmail" ? normalizeGmailMessage : normalizeOutlookMessage;
  const messages = rawMessages
    .map((m) => normalize(m, accountEmail, connectedAccountId))
    .filter((m): m is MailMessage => m !== null);
  const nextPageToken =
    (typeof data.nextPageToken === "string" && data.nextPageToken) ||
    (typeof data.next_page_token === "string" && data.next_page_token) ||
    undefined;
  const hasMore =
    toolkit === "gmail"
      ? Boolean(nextPageToken)
      : Boolean(data["@odata.nextLink"]) || rawMessages.length >= 20;
  return { messages, nextPageToken, hasMore };
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
        ? buildGmailSendArguments(to, subject, body)
        : buildOutlookSendArguments(to, subject, body),
  });
  return res.successful ? { ok: true } : { ok: false, error: res.error ?? "Send failed" };
}

export async function markComposioGmailReadState(
  connectedAccountId: string,
  userId: string,
  messageId: string,
  unread: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const res = await executeTool({
    toolSlug: GMAIL_MODIFY_LABELS_TOOL,
    connectedAccountId,
    userId,
    arguments: {
      user_id: "me",
      message_id: messageId,
      add_label_ids: unread ? ["UNREAD"] : [],
      remove_label_ids: unread ? [] : ["UNREAD"],
    },
  });
  return res.successful ? { ok: true } : { ok: false, error: res.error ?? "Gmail read state update failed" };
}

export async function archiveComposioGmailMessage(
  connectedAccountId: string,
  userId: string,
  messageId: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await executeTool({
    toolSlug: GMAIL_MODIFY_LABELS_TOOL,
    connectedAccountId,
    userId,
    arguments: {
      user_id: "me",
      message_id: messageId,
      remove_label_ids: ["INBOX"],
    },
  });
  return res.successful ? { ok: true } : { ok: false, error: res.error ?? "Gmail archive failed" };
}

export async function trashComposioGmailMessage(
  connectedAccountId: string,
  userId: string,
  messageId: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await executeTool({
    toolSlug: GMAIL_MOVE_TO_TRASH_TOOL,
    connectedAccountId,
    userId,
    arguments: {
      user_id: "me",
      message_id: messageId,
    },
  });
  return res.successful ? { ok: true } : { ok: false, error: res.error ?? "Gmail move to trash failed" };
}
