import type { MailMessage } from "@/lib/mail/gmail";

type MailAccountRef = Pick<MailMessage, "provider" | "accountEmail"> & {
  connectedAccountId?: string;
};

/** Build mail API query string with optional Composio account disambiguation. */
export function mailAccountQuery(msg: MailAccountRef): string {
  const params = new URLSearchParams({
    provider: msg.provider,
    email: msg.accountEmail,
  });
  if (msg.connectedAccountId) {
    params.set("accountId", msg.connectedAccountId);
  }
  return params.toString();
}
