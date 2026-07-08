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
// Gmail's single-message fetch tool. Verified live against Composio's
// /tools/{slug} schema endpoint on 2026-07-08: `GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID`
// is the only Gmail single-message tool Composio exposes. A previously-guessed
// alternate slug, `GMAIL_GET_MESSAGE`, does NOT exist (schema lookup returns
// `not_found` with suggestions pointing at unrelated tools) and has been
// removed rather than kept as a dead fallback. Its confirmed input schema is
// `{ message_id: string (required), user_id?: string (default "me"),
// format?: "metadata"|"minimal"|"full"|"raw" (default "full") }`; its output
// shape is `{ messageId, threadId, sender, subject, messageTimestamp,
// messageText, payload, attachmentList, labelIds, preview }` — the native
// Gmail API `payload` (headers as a `{name,value}[]`, base64url MIME parts)
// plus a handful of Composio convenience fields, mapped defensively below the
// same way `normalizeGmailMessage` already handles list rows.
const GMAIL_GET_MESSAGE_TOOL = "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID";

// Outlook's single-message fetch tool/args are NOT yet confirmed against a
// live connected account or Composio's schema endpoint, so it keeps the
// defensive multi-arg-variant loop below. A wrong slug/args surfaces as a
// structured `provider_error` the UI shows, which is strictly better than the
// previous behavior (the message detail route had no Composio branch at all,
// so Composio rows 404'd silently). Verify on first live Outlook test.
const OUTLOOK_GET_MESSAGE_TOOL = "OUTLOOK_OUTLOOK_GET_MESSAGE";
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

// Some Composio payload shapes nest a preview/summary object (e.g. Gmail's
// confirmed `preview` field) instead of a flat string field.
function nestedStringField(source: Record<string, unknown>, containerKey: string, keys: string[]): string | undefined {
  const container = asRecord(source[containerKey]);
  return container ? stringField(container, keys) : undefined;
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

function gmailGetMessageArguments(messageId: string): Record<string, unknown> {
  return { message_id: messageId, user_id: "me", format: "full" };
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
  // `attachmentList` is Gmail's confirmed flattened attachment field (see the
  // GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID output schema note above); the others
  // are defensive fallbacks for Outlook / unconfirmed shapes.
  const raw = m.attachmentList ?? m.attachments ?? m.attachment ?? m.files ?? m.fileAttachments;
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
  const headers = (m.payload as Record<string, unknown> | undefined)?.headers;
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
    snippet:
      (m.snippet as string) ??
      nestedStringField(m, "preview", ["snippet", "text", "summary", "body"]) ??
      (m.messageText as string)?.slice(0, 200) ??
      "",
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
  // Prefer attachments parsed from the native MIME payload (has real
  // attachmentId/size per part); fall back to Composio's flattened
  // `attachmentList` when the payload didn't yield any (e.g. a lighter
  // `format` was used, or a part shape we don't recognize).
  const payloadAttachments = payload ? extractGmailAttachments(payload) : [];
  const attachments = payloadAttachments.length ? payloadAttachments : extractGenericAttachments(m);
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

/**
 * Fetch a single message's full body via Composio. Throws ComposioError on
 * provider failure (the adapter wraps it into a structured Result); returns
 * null only when the message genuinely isn't found / can't be normalized.
 *
 * Gmail uses the single verified tool slug + confirmed argument shape
 * (`GMAIL_GET_MESSAGE_TOOL`, above) in one call — no more guessing across
 * multiple candidate slugs/args. Outlook's slug/args are still unconfirmed,
 * so it keeps the defensive fallback loop until a live account validates it.
 */
export async function getComposioMessage(
  toolkit: MailToolkit,
  connectedAccountId: string,
  userId: string,
  messageId: string,
  accountEmail: string,
): Promise<MailMessageFull | null> {
  if (toolkit === "gmail") {
    const res = await executeTool({
      toolSlug: GMAIL_GET_MESSAGE_TOOL,
      connectedAccountId,
      userId,
      arguments: gmailGetMessageArguments(messageId),
    });
    if (!res.successful) {
      throw new ComposioError(res.error ?? "gmail get-message failed", 502);
    }
    const raw = unwrapMessageRecord(res.data as Record<string, unknown>);
    return normalizeGmailMessageFull(raw, accountEmail, connectedAccountId);
  }

  let lastError: string | null = null;
  for (const args of outlookGetMessageArguments(messageId)) {
    const res = await executeTool({
      toolSlug: OUTLOOK_GET_MESSAGE_TOOL,
      connectedAccountId,
      userId,
      arguments: args,
    });
    if (!res.successful) {
      lastError = res.error ?? "outlook get-message failed";
      continue;
    }
    const raw = unwrapMessageRecord(res.data as Record<string, unknown>);
    const message = normalizeOutlookMessageFull(raw, accountEmail, connectedAccountId);
    if (message) return message;
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
