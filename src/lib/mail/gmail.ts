// Gmail message/attachment TYPES and payload parsers, shared by the Composio
// Gmail/Outlook adapters (Composio returns the native Gmail payload shape). The
// direct-OAuth Gmail API client that used to live below was removed with the
// rest of the direct adapters — this file no longer performs any I/O.
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
  /** Opaque Axis connection UUID used by browser account selection. */
  connectionId?: string;
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

// Match a part's mimeType, tolerating trailing parameters some payload shapes
// pass through (e.g. "text/html; charset=UTF-8" — Composio-relayed messages).
function mimeTypeMatches(partMimeType: string | undefined, mimeType: "text/html" | "text/plain"): boolean {
  if (!partMimeType) return false;
  return partMimeType.toLowerCase().split(";")[0].trim() === mimeType;
}

function findBodyPart(payload: GmailPayload, mimeType: "text/html" | "text/plain"): GmailPayload | null {
  if (mimeTypeMatches(payload.mimeType, mimeType) && payload.body?.data) {
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
      isHtml: mimeTypeMatches(payload.mimeType, "text/html"),
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
