import { listComposioMailAccounts } from "./composio";

export type MailProvider = "gmail" | "outlook";

export type MailAccountRef = {
  provider: MailProvider;
  mailEmail: string;
  via?: "composio";
  connectedAccountId?: string;
};

// Mail is Composio-only after the direct-adapter removal, so a "mail account" is
// simply a Composio-connected mailbox. The direct token store (getMailTokens /
// saveMailTokens / getFreshMailAccessToken / deleteMailTokens) and the legacy
// mail_connections table it read/wrote are gone; that table holds zero rows in
// production and no code path references it anymore.
export async function listMailAccounts(userId: string): Promise<MailAccountRef[]> {
  const composioAccounts = await listComposioMailAccounts(userId);
  return composioAccounts.map((a) => ({
    provider: a.provider,
    mailEmail: a.mailEmail,
    via: "composio" as const,
    connectedAccountId: a.connectedAccountId,
  }));
}
