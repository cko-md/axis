import { getFreshMailAccessToken } from "./tokens";
import type { MailAttachment, MailMessage, MailMessageFull } from "./gmail";
import { normalizeMailDate } from "./dates";

interface OutlookEmailAddress {
  name: string;
  address: string;
}

interface OutlookMessage {
  id: string;
  conversationId?: string;
  from?: { emailAddress: OutlookEmailAddress };
  subject: string;
  receivedDateTime: string;
  bodyPreview?: string;
  isRead: boolean;
  body?: { contentType: string; content: string };
  attachments?: Array<{
    id?: string;
    name?: string;
    contentType?: string;
    size?: number;
    isInline?: boolean;
  }>;
}

function formatSender(msg: OutlookMessage): string {
  const ea = msg.from?.emailAddress;
  if (!ea) return "";
  return ea.name ? `${ea.name} <${ea.address}>` : ea.address;
}

export async function listOutlookInbox(
  userId: string,
  mailEmail: string,
  skip = 0,
): Promise<{ messages: MailMessage[]; hasMore: boolean }> {
  const token = await getFreshMailAccessToken(userId, "outlook", mailEmail);
  if (!token) return { messages: [], hasMore: false };

  const params = new URLSearchParams({
    $select: "id,conversationId,from,subject,receivedDateTime,bodyPreview,isRead",
    $top: "20",
    $skip: String(skip),
    $orderby: "receivedDateTime desc",
  });

  const res = await fetch(
    `https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages?${params}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) return { messages: [], hasMore: false };
  const data = await res.json();

  const messages: MailMessage[] = ((data.value ?? []) as OutlookMessage[]).map((msg) => ({
    id: msg.id,
    threadId: msg.conversationId ?? msg.id,
    from: formatSender(msg),
    subject: msg.subject || "(no subject)",
    date: normalizeMailDate(msg.receivedDateTime),
    snippet: msg.bodyPreview ?? "",
    isUnread: !msg.isRead,
    provider: "outlook" as const,
    accountEmail: mailEmail,
  }));

  return { messages, hasMore: !!data["@odata.nextLink"] };
}

export async function getOutlookMessage(
  userId: string,
  mailEmail: string,
  messageId: string,
): Promise<MailMessageFull | null> {
  const token = await getFreshMailAccessToken(userId, "outlook", mailEmail);
  if (!token) return null;

  const res = await fetch(
    `https://graph.microsoft.com/v1.0/me/messages/${messageId}?$select=id,conversationId,from,subject,receivedDateTime,body,bodyPreview,isRead&$expand=attachments($select=id,name,contentType,size,isInline)`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) return null;
  const msg = (await res.json()) as OutlookMessage;

  const bodyContent = msg.body?.content ?? msg.bodyPreview ?? "";
  const isHtml = msg.body?.contentType?.toLowerCase() === "html";
  const attachments: MailAttachment[] = (msg.attachments ?? [])
    .filter((att) => att.id && att.name)
    .map((att) => ({
      id: att.id!,
      filename: att.name!,
      mimeType: att.contentType ?? "application/octet-stream",
      sizeBytes: typeof att.size === "number" ? att.size : null,
      inline: !!att.isInline,
    }));

  return {
    id: msg.id,
    threadId: msg.conversationId ?? msg.id,
    from: formatSender(msg),
    subject: msg.subject || "(no subject)",
    date: normalizeMailDate(msg.receivedDateTime),
    snippet: msg.bodyPreview ?? "",
    isUnread: !msg.isRead,
    provider: "outlook" as const,
    accountEmail: mailEmail,
    body: bodyContent,
    bodyIsHtml: isHtml,
    attachments,
  };
}
