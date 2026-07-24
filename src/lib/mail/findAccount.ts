import type { MailAccountRef, MailProvider } from "@/lib/mail/tokens";

const PLACEHOLDER_EMAIL = "Connected account";

/**
 * Resolve a mail account only from an Axis-owned connection UUID.
 *
 * Mail is Composio-only: provider and mailbox address are display metadata and
 * may legitimately be duplicated. Keeping the legacy fallback would turn a
 * same-label account into a confused-deputy selector.
 */
export function findMailAccount(
  accounts: MailAccountRef[],
  provider: MailProvider,
  email: string,
  accountId?: string | null,
): MailAccountRef | undefined {
  if (accountId) {
    const matches = accounts.filter((account) =>
      account.connectionId === accountId
      && account.provider === provider
      && (account.mailEmail === email || (account.mailEmail === PLACEHOLDER_EMAIL && email === PLACEHOLDER_EMAIL)),
    );
    return matches.length === 1 ? matches[0] : undefined;
  }
  // Deliberately do not fall back to the e-mail address, including the generic
  // "Connected account" label. Callers must resend the opaque local UUID.
  return undefined;
}
