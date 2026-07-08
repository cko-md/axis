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
import { decodeBase64Url, extractBody, extractGmailAttachments, type GmailPayload, type MailAttachment, type MailMessage, type MailMessageFull } from "./gmail";
import { normalizeMailDate } from "./dates";

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
// Single-message fetch tools. Gmail detail is verified against Composio as
// GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID; do not fall back to unverified aliases.
const GET_TOOL: Record<MailToolkit, readonly string[]> = {
  gmail: ["GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID"],
  outlook: ["OUTLOOK_OUTLOOK_GET_MESSAGE"],
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
  const normalizedName = name.toLowerCase();
  if (Array.isArray(headers)) {
    for (const item of headers) {
      const header = asRecord(item);
      if (!header) continue;
      const headerName = stringField(header, ["name", "key", "header", "headerName"]);
      if (headerName?.toLowerCase() !== normalizedName) continue;
      const value = stringField(header, ["value", "val", "text"]);
      if (value) return value;
    }
    return "";
  }

  const headerRecord = asRecord(headers);
  if (!headerRecord) return "";
  for (const [key, rawValue] of Object.entries(headerRecord)) {
    if (key.toLowerCase() !== normalizedName) continue;
    if (typeof rawValue === "string" && rawValue.trim()) return rawValue;
    const valueRecord = asRecord(rawValue);
    if (valueRecord) return stringField(valueRecord, ["value", "val", "text"]) ?? "";
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

function hasMessageIdentity(record: Record<string, unknown>): boolean {
  return Boolean(stringField(record, ["id", "messageId", "message_id"]));
}

function unwrapMessageRecord(data: unknown, depth = 0): Record<string, unknown> {
  const record = asRecord(Array.isArray(data) ? data[0] : data);
  if (!record || depth > 5) return asRecord(data) ?? {};
  if (hasMessageIdentity(record)) return record;

  const candidates = [
    record.message,
    record.email,
    record.data,
    record.result,
    record.response_data,
    record.responseData,
    record.payload,
    record.output,
    record.response,
    record.item,
    record.items,
  ];

  for (const candidate of candidates) {
    const nested = unwrapMessageRecord(candidate, depth + 1);
    if (hasMessageIdentity(nested)) return nested;
  }

  return record;
}

function gmailGetMessageArguments(messageId: string): Record<string, unknown>[] {
  return [
    { message_id: messageId, user_id: "me", format: "full" },
    { message_id: messageId, user_id: "me", format: "FULL" },
    { messageId, user_id: "me", format: "full" },
    { id: messageId, user_id: "me", format: "full" },
    { message_id: messageId },
  ];
}

function outlookGetMessageArguments(messageId: string): Record<string, unknown>[] {
  return [
    { message_id: messageId },
    { messageId },
    { id: messageId },
  ];
}

function looksLikeHtml(value: string): boolean {
  return /<\/?[a-z][\s\S]*>/i.test(value);
}

function decodedBodyData(value: string): string {
  return decodeBase64Url(value) || value;
}

function bodyFromObject(bodyObj: Record<string, unknown>): { body: string; bodyIsHtml: boolean } | null {
  const content = stringField(bodyObj, [
    "content",
    "body",
    "value",
    "html",
    "htmlBody",
    "bodyHtml",
    "text",
    "plainText",
    "bodyText",
  ]);
  const contentType = stringField(bodyObj, ["contentType", "content_type", "mimeType", "mime_type"]) ?? "";
  if (content) {
    return { body: content, bodyIsHtml: contentType.toLowerCase().includes("html") || looksLikeHtml(content) };
  }

  const data = stringField(bodyObj, ["data"]);
  if (data) {
    return { body: decodedBodyData(data), bodyIsHtml: contentType.toLowerCase().includes("html") };
  }

  return null;
}

function extractProviderBody(m: Record<string, unknown>): { body: string; bodyIsHtml: boolean } {
  const bodyObj = asRecord(m.body);
  if (bodyObj) {
    const extracted = bodyFromObject(bodyObj);
    if (extracted) return extracted;
  }

  const html = stringField(m, [
    "messageHtml",
    "bodyHtml",
    "htmlBody",
    "body_html",
    "html_body",
    "html",
    "renderedBody",
    "rawHtml",
  ]);
  if (html) return { body: html, bodyIsHtml: true };

  const genericBody = stringField(m, ["body", "messageBody", "message_body", "content"]);
  if (genericBody) return { body: genericBody, bodyIsHtml: looksLikeHtml(genericBody) };

  const text = stringField(m, [
    "messageText",
    "bodyText",
    "plainText",
    "textBody",
    "body_text",
    "text_body",
    "textPlain",
    "plain",
    "text",
    "snippet",
    "bodyPreview",
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
  const raw = m.attachments ?? m.attachment ?? m.files ?? m.fileAttachments;
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

function gmailHeaderFromMessage(m: Record<string, unknown>, name: string): string {
  const payload = asRecord(m.payload);
  for (const source of [payload?.headers, m.headers, m.header, m.messageHeaders, m.message_headers]) {
    const value = gmailHeader(source, name);
    if (value) return value;
  }
  return "";
}

function addressField(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value;
    const record = asRecord(value);
    if (!record) continue;
    const emailAddress = asRecord(record.emailAddress) ?? asRecord(record.email_address);
    const addressRecord = emailAddress ?? record;
    const address = stringField(addressRecord, ["address", "email", "emailAddress", "email_address", "mail"]);
    const displayName = stringField(addressRecord, ["name", "displayName", "display_name"]);
    if (address && displayName) return `${displayName} <${address}>`;
    if (address) return address;
  }
  return undefined;
}

// Normalizes a single Gmail-toolkit message into the same MailMessage shape
// gmail.ts produces, trying both the raw Gmail API resource shape (payload/
// headers/labelIds — Composio's Gmail tools are documented to stay close to
// the native API) and Composio's flattened convenience fields as a fallback.
export function normalizeGmailMessage(
  m: Record<string, unknown>,
  accountEmail: string,
  connectedAccountId?: string,
): MailMessage | null {
  const id = stringField(m, ["id", "messageId", "message_id"]);
  if (!id) return null;
  const labelIds = Array.isArray(m.labelIds)
    ? m.labelIds
    : Array.isArray(m.label_ids)
      ? m.label_ids
      : Array.isArray(m.labels)
        ? m.labels
        : [];
  return {
    id,
    threadId: stringField(m, ["threadId", "thread_id", "conversationId", "conversation_id"]) ?? id,
    from: gmailHeaderFromMessage(m, "From") || addressField(m, ["sender", "from", "fromEmail", "from_email"]) || "",
    subject: gmailHeaderFromMessage(m, "Subject") || stringField(m, ["subject", "title"]) || "(no subject)",
    date: normalizeMailDate(
      gmailHeaderFromMessage(m, "Date") ||
        m.messageTimestamp ||
        m.internalDate ||
        m.internal_date ||
        m.receivedDateTime ||
        m.received_date_time ||
        m.date,
    ),
    snippet: stringField(m, ["snippet", "preview", "bodyPreview", "messageText"])?.slice(0, 200) ?? "",
    isUnread: labelIds.some((label) => typeof label === "string" && label.toUpperCase() === "UNREAD"),
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
  return { ...base, body, bodyIsHtml, attachments: payload ? extractGmailAttachments(payload) : extractGenericAttachments(m) };
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
    throw new ComposioError(lastError, 502);
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
            folder: "Inbox",
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
        ? { recipient_email: to, subject, body }
        : { to_email: to, subject, body },
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
