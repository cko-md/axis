import type { MailMessagePublic } from "@/lib/mail/tokens";

type MailAccountRef = Pick<MailMessagePublic, "provider" | "accountEmail"> & {
  connectionId?: string;
};

/** Build mail API query string with optional Composio account disambiguation. */
export function mailAccountQuery(msg: MailAccountRef): string {
  const params = new URLSearchParams({
    provider: msg.provider,
    email: msg.accountEmail,
  });
  if (msg.connectionId) params.set("accountId", msg.connectionId);
  return params.toString();
}
