import { listComposioMailAccounts } from "./composio";
import type { MailMessage, MailMessageFull } from "./gmail";
import type { IntegrationError, IntegrationErrorCode } from "@/lib/integrations/types";

export type MailProvider = "gmail" | "outlook";

/** Server-only account data. Mail carries only Axis-owned connection identity. */
export type MailAccountRef = {
  provider: MailProvider;
  mailEmail: string;
  via?: "composio";
  /** Opaque Axis connection UUID, safe to return to browser clients. */
  connectionId?: string;
};

/** Deliberately narrow account shape permitted to cross a Mail HTTP boundary. */
export type MailAccountPublic = {
  provider: MailProvider;
  mailEmail: string;
  via?: "composio";
  connectionId?: string;
};

/** Browser-safe Mail records never contain a provider account identifier. */
export type MailMessagePublic = MailMessage;
export type MailMessageFullPublic = MailMessageFull;

export type MailPublicError = Pick<IntegrationError, "code" | "message" | "retryable">;

const PUBLIC_ERROR_MESSAGES: Record<IntegrationErrorCode, string> = {
  auth_expired: "Mailbox access has expired. Reconnect this mailbox and try again.",
  rate_limited: "This mailbox is temporarily rate limited. Try again shortly.",
  not_found: "This mail item is no longer available.",
  not_supported: "This mailbox does not support that action yet.",
  invalid_request: "This mail request could not be completed.",
  provider_error: "The mailbox could not complete the request. Try again.",
  network: "The mailbox could not be reached. Try again.",
  unknown: "The mailbox could not complete the request. Try again.",
};

/**
 * Provider messages are untrusted content. Normalize them before a response,
 * an Error instance, or Sentry can receive them.
 */
export function publicMailError(error: Pick<IntegrationError, "code" | "retryable">): MailPublicError {
  return {
    code: error.code,
    message: PUBLIC_ERROR_MESSAGES[error.code],
    retryable: error.retryable,
  };
}

// Mail is Composio-only after the direct-adapter removal, so a "mail account" is
// simply a Composio-connected mailbox. The direct token store (getMailTokens /
// saveMailTokens / getFreshMailAccessToken / deleteMailTokens) and the legacy
// mail_connections table it read/wrote are gone; that table holds zero rows in
// production and no code path references it anymore.
export async function listMailAccounts(
  userId: string,
  options: { verifyRemote?: boolean } = {},
): Promise<MailAccountRef[]> {
  const composioAccounts = await listComposioMailAccounts(userId, { verifyRemote: options.verifyRemote ?? false });
  return composioAccounts.map((a) => ({
    provider: a.provider,
    mailEmail: a.mailEmail,
    via: "composio" as const,
    connectionId: a.connectionId,
  }));
}

/** Remove server-only provider identifiers before an account crosses HTTP. */
export function projectMailAccount(account: MailAccountRef): MailAccountPublic {
  return {
    provider: account.provider,
    mailEmail: account.mailEmail,
    via: account.via,
    connectionId: account.connectionId,
  };
}

/** Bind a normalized message to its opaque local account selector. */
export function projectMailMessage(message: MailMessage, account?: MailAccountRef): MailMessagePublic;
export function projectMailMessage(message: MailMessageFull, account?: MailAccountRef): MailMessageFullPublic;
export function projectMailMessage(
  message: MailMessage | MailMessageFull,
  account?: MailAccountRef,
): MailMessagePublic | MailMessageFullPublic {
  return {
    ...message,
    connectionId: account?.connectionId ?? message.connectionId,
  };
}
