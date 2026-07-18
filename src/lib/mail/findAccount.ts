import type { MailAccountRef, MailProvider } from "@/lib/mail/tokens";

const PLACEHOLDER_EMAIL = "Connected account";

/** Resolve a mail account from provider + email, with Composio placeholder fallbacks. */
export function findMailAccount(
  accounts: MailAccountRef[],
  provider: MailProvider,
  email: string,
  accountId?: string | null,
): MailAccountRef | undefined {
  if (accountId) {
    const byId = accounts.find((account) => account.provider === provider && account.connectedAccountId === accountId);
    if (byId) return byId;
  }

  const exact = accounts.find((account) => account.provider === provider && account.mailEmail === email);
  if (exact) return exact;

  const composioMatches = accounts.filter(
    (account) => account.provider === provider && account.via === "composio",
  );
  if (
    composioMatches.length === 1
    && (email === PLACEHOLDER_EMAIL || !email.includes("@"))
  ) {
    return composioMatches[0];
  }

  return undefined;
}
