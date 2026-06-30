import { getFreshMailAccessToken } from "./tokens";
import { normalizeMailDate } from "./dates";

export interface MailMessage {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
  isUnread: boolean;
  provider: "gmail" | "outlook";
  accountEmail: string;
}

export interface MailMessageFull extends MailMessage {
  body: string;
  bodyIsHtml: boolean;
  attachments?: MailAttachment[];
}

export interface MailAttachment {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number | null;
  inline?: boolean;
}

export interface MailAttachmentFile extends MailAttachment {
  bytes: Buffer;
}

// Exported so the Composio Gmail adapter can reuse the exact same body/header
// normalization (Composio's Gmail tools return the native API payload shape).
export interface GmailPayload {
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: GmailPayload[];
}

export function getHeader(headers: Array<{ name: string; value: string }>, name: string): string {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

export function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  try {
    return Buffer.from(base64, "base64").toString("utf-8");
  } catch {
    return "";
  }
}

function findBodyPart(payload: GmailPayload, mimeType: "text/html" | "text/plain"): GmailPayload | null {
  if (payload.mimeType?.toLowerCase() === mimeType && payload.body?.data) {
    return payload;
  }
  for (const part of payload.parts ?? []) {
    const found = findBodyPart(part, mimeType);
    if (found) return found;
  }
  return null;
}

export function extractBody(payload: GmailPayload): { content: string; isHtml: boolean } {
  const html = findBodyPart(payload, "text/html");
  if (html?.body?.data) {
    return { content: decodeBase64Url(html.body.data), isHtml: true };
  }

  const plain = findBodyPart(payload, "text/plain");
  if (plain?.body?.data) {
    return { content: decodeBase64Url(plain.body.data), isHtml: false };
  }

  if (payload.body?.data) {
    return {
      content: decodeBase64Url(payload.body.data),
      isHtml: payload.mimeType?.toLowerCase() === "text/html",
    };
  }

  return { content: "", isHtml: false };
}

export function extractGmailAttachments(payload: GmailPayload): MailAttachment[] {
  const attachments: MailAttachment[] = [];
  const walk = (part: GmailPayload) => {
    const filename = part.filename?.trim();
    const attachmentId = part.body?.attachmentId;
    if (filename && attachmentId) {
      attachments.push({
        id: attachmentId,
        filename,
        mimeType: part.mimeType ?? "application/octet-stream",
        sizeBytes: typeof part.body?.size === "number" ? part.body.size : null,
        inline: /^image\//i.test(part.mimeType ?? "") && !filename.toLowerCase().endsWith(".pdf"),
      });
    }
    for (const child of part.parts ?? []) walk(child);
  };
  walk(payload);
  return attachments;
}

export async function getGmailAttachment(
  userId: string,
  mailEmail: string,
  messageId: string,
  attachment: MailAttachment,
): Promise<MailAttachmentFile | null> {
  const token = await getFreshMailAccessToken(userId, "gmail", mailEmail);
  if (!token) return null;

  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachment.id)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) return null;

  const data = await res.json().catch(() => null) as { data?: string } | null;
  if (!data?.data) return null;
  const base64 = data.data.replace(/-/g, "+").replace(/_/g, "/");
  return { ...attachment, bytes: Buffer.from(base64, "base64") };
}

export async function listGmailInbox(
  userId: string,
  mailEmail: string,
  pageToken?: string,
): Promise<{ messages: MailMessage[]; nextPageToken?: string }> {
  const token = await getFreshMailAccessToken(userId, "gmail", mailEmail);
  if (!token) return { messages: [] };

  const params = new URLSearchParams({ labelIds: "INBOX", maxResults: "20" });
  if (pageToken) params.set("pageToken", pageToken);

  const listRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!listRes.ok) return { messages: [] };
  const listData = await listRes.json();
  if (!listData.messages?.length) return { messages: [], nextPageToken: listData.nextPageToken };

  const messages = await Promise.all(
    (listData.messages as Array<{ id: string; threadId: string }>).map(async (msg) => {
      const msgRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!msgRes.ok) return null;
      const d = await msgRes.json();
      const headers: Array<{ name: string; value: string }> = d.payload?.headers ?? [];
      return {
        id: d.id as string,
        threadId: d.threadId as string,
        from: getHeader(headers, "From"),
        subject: getHeader(headers, "Subject") || "(no subject)",
        date: normalizeMailDate(getHeader(headers, "Date") || d.internalDate),
        snippet: (d.snippet as string) ?? "",
        isUnread: ((d.labelIds as string[]) ?? []).includes("UNREAD"),
        provider: "gmail" as const,
        accountEmail: mailEmail,
      };
    }),
  );

  return {
    messages: messages.filter(Boolean) as MailMessage[],
    nextPageToken: listData.nextPageToken as string | undefined,
  };
}

export async function getGmailMessage(
  userId: string,
  mailEmail: string,
  messageId: string,
): Promise<MailMessageFull | null> {
  const token = await getFreshMailAccessToken(userId, "gmail", mailEmail);
  if (!token) return null;

  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) return null;
  const d = await res.json();
  const headers: Array<{ name: string; value: string }> = d.payload?.headers ?? [];
  const { content, isHtml } = extractBody(d.payload ?? {});
  const attachments = extractGmailAttachments(d.payload ?? {});

  return {
    id: d.id as string,
    threadId: d.threadId as string,
    from: getHeader(headers, "From"),
    subject: getHeader(headers, "Subject") || "(no subject)",
    date: normalizeMailDate(getHeader(headers, "Date") || d.internalDate),
    snippet: (d.snippet as string) ?? "",
    isUnread: ((d.labelIds as string[]) ?? []).includes("UNREAD"),
    provider: "gmail",
    accountEmail: mailEmail,
    body: content,
    bodyIsHtml: isHtml,
    attachments,
  };
}
