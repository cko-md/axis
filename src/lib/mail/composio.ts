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
import { executeTool } from "@/lib/integrations/composio";
import type { MailMessage } from "./gmail";

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

export type ComposioMailAccount = {
  provider: "gmail" | "outlook";
  mailEmail: string;
  via: "composio";
  connectedAccountId: string;
};

export async function listComposioMailAccounts(userId: string): Promise<ComposioMailAccount[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("composio_connections")
    .select("toolkit, connected_account_id, account_label")
    .eq("user_id", userId)
    .eq("status", "ACTIVE")
    .in("toolkit", ["gmail", "outlook"])
    .not("account_label", "is", null);

  return (data ?? []).map((row) => ({
    provider: row.toolkit as "gmail" | "outlook",
    mailEmail: row.account_label as string,
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

// Normalizes a single Gmail-toolkit message into the same MailMessage shape
// gmail.ts produces, trying both the raw Gmail API resource shape (payload/
// headers/labelIds — Composio's Gmail tools are documented to stay close to
// the native API) and Composio's flattened convenience fields as a fallback.
function normalizeGmailMessage(m: Record<string, unknown>, accountEmail: string): MailMessage | null {
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

function normalizeOutlookMessage(m: Record<string, unknown>, accountEmail: string): MailMessage | null {
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
