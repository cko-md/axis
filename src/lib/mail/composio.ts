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
import { extractBody, extractGmailAttachments, type GmailPayload, type MailAttachment, type MailMessage, type MailMessageFull } from "./gmail";
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
// Single-message fetch tools. Best-effort slugs (Gmail's single-message fetch
// and Outlook's get-message) — NOT yet confirmed against a live connected
// account, mapped defensively like the list normalizers above. A wrong slug
// surfaces as a structured `provider_error` the UI shows, which is strictly
// better than the previous behavior (the message detail route had no Composio
// branch at all, so Composio rows 404'd silently). Verify on first live test.
const GET_TOOL: Record<MailToolkit, string[]> = {
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
  const nestedPayload = asRecord(m.payload);
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
    "message_html",
    "bodyHtml",
    "htmlBody",
    "body_html",
    "html_body",
    "html",
    "renderedBody",
    "rendered_body",
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

// Normalizes a single Gmail-toolkit message into the same MailMessage shape
// gmail.ts produces, trying both the raw Gmail API resource shape (payload/
// headers/labelIds — Composio's Gmail tools are documented to stay close to
// the native API) and Composio's flattened convenience fields as a fallback.
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
    from: gmailHeader(headers, "From") || (m.sender as string) || (m.from as string) || "",
    subject: gmailHeader(headers, "Subject") || (m.subject as string) || "(no subject)",
    date: normalizeMailDate(
      gmailHeader(headers, "Date") ||
        m.messageTimestamp ||
        m.internalDate ||
        m.receivedDateTime ||
        m.date,
    ),
    snippet: (m.snippet as string) ?? (m.messageText as string)?.slice(0, 200) ?? "",
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
