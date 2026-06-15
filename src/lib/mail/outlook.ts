import { getFreshMailAccessToken } from "./tokens";
import type { MailMessage, MailMessageFull } from "./gmail";

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
}

function formatSender(msg: OutlookMessage): string {
  const ea = msg.from?.emailAddress;
  if (!ea) return "";
  return ea.name ? `${ea.name} <${ea.address}>` : ea.address;
}

export async function listOutlookInbox(
  userId: string,
  skip = 0,
): Promise<{ messages: MailMessage[]; hasMore: boolean }> {
  const token = await getFreshMailAccessToken(userId, "outlook");
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
    date: msg.receivedDateTime,
    snippet: msg.bodyPreview ?? "",
    isUnread: !msg.isRead,
    provider: "outlook" as const,
  }));

  return { messages, hasMore: !!data["@odata.nextLink"] };
}

export async function getOutlookMessage(
  userId: string,
  messageId: string,
): Promise<MailMessageFull | null> {
  const token = await getFreshMailAccessToken(userId, "outlook");
  if (!token) return null;

  const res = await fetch(
    `https://graph.microsoft.com/v1.0/me/messages/${messageId}?$select=id,conversationId,from,subject,receivedDateTime,body,bodyPreview,isRead`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) return null;
  const msg = (await res.json()) as OutlookMessage;

  const bodyContent = msg.body?.content ?? msg.bodyPreview ?? "";
  const isHtml = msg.body?.contentType?.toLowerCase() === "html";

  return {
    id: msg.id,
    threadId: msg.conversationId ?? msg.id,
    from: formatSender(msg),
    subject: msg.subject || "(no subject)",
    date: msg.receivedDateTime,
    snippet: msg.bodyPreview ?? "",
    isUnread: !msg.isRead,
    provider: "outlook" as const,
    body: bodyContent,
    bodyIsHtml: isHtml,
  };
}
