import { getFreshMailAccessToken } from "./tokens";

export interface MailMessage {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
  isUnread: boolean;
  provider: "gmail" | "outlook";
}

export interface MailMessageFull extends MailMessage {
  body: string;
  bodyIsHtml: boolean;
}

interface GmailPayload {
  mimeType?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { data?: string };
  parts?: GmailPayload[];
}

function getHeader(headers: Array<{ name: string; value: string }>, name: string): string {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  try {
    return Buffer.from(base64, "base64").toString("utf-8");
  } catch {
    return "";
  }
}

function extractBody(payload: GmailPayload): { content: string; isHtml: boolean } {
  if (payload.body?.data) {
    const isHtml = payload.mimeType === "text/html";
    return { content: decodeBase64Url(payload.body.data), isHtml };
  }
  if (payload.parts) {
    const plain = payload.parts.find((p) => p.mimeType === "text/plain");
    if (plain?.body?.data) return { content: decodeBase64Url(plain.body.data), isHtml: false };
    const html = payload.parts.find((p) => p.mimeType === "text/html");
    if (html?.body?.data) return { content: decodeBase64Url(html.body.data), isHtml: true };
    for (const part of payload.parts) {
      if (part.parts) {
        const nested = extractBody(part);
        if (nested.content) return nested;
      }
    }
  }
  return { content: "", isHtml: false };
}

export async function listGmailInbox(
  userId: string,
  pageToken?: string,
): Promise<{ messages: MailMessage[]; nextPageToken?: string }> {
  const token = await getFreshMailAccessToken(userId, "gmail");
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
        date: getHeader(headers, "Date"),
        snippet: (d.snippet as string) ?? "",
        isUnread: ((d.labelIds as string[]) ?? []).includes("UNREAD"),
        provider: "gmail" as const,
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
  messageId: string,
): Promise<MailMessageFull | null> {
  const token = await getFreshMailAccessToken(userId, "gmail");
  if (!token) return null;

  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) return null;
  const d = await res.json();
  const headers: Array<{ name: string; value: string }> = d.payload?.headers ?? [];
  const { content, isHtml } = extractBody(d.payload ?? {});

  return {
    id: d.id as string,
    threadId: d.threadId as string,
    from: getHeader(headers, "From"),
    subject: getHeader(headers, "Subject") || "(no subject)",
    date: getHeader(headers, "Date"),
    snippet: (d.snippet as string) ?? "",
    isUnread: ((d.labelIds as string[]) ?? []).includes("UNREAD"),
    provider: "gmail",
    body: content,
    bodyIsHtml: isHtml,
  };
}
