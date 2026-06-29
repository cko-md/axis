// The single contract every mail provider implements — direct Gmail, direct
// Outlook, Composio Gmail, Composio Outlook. All four return the SAME normalized
// `MailMessage`/`MailMessageFull` types and the SAME `Result<T>` structured
// errors, so API routes call generic methods and never branch on provider.

import type { MailMessage, MailMessageFull } from "../gmail";
import type { MailProvider, MailAccountRef } from "../tokens";
import type { IntegrationTransport, Result } from "../../integrations/types";

export type { MailMessage, MailMessageFull } from "../gmail";

/**
 * Everything an adapter method needs to act on one account. Built from a
 * `MailAccountRef` (from `listMailAccounts`) + the authenticated user id, so the
 * adapter itself stays stateless and the caller owns ownership verification.
 */
export interface MailAccountContext {
  userId: string;
  provider: MailProvider;
  mailEmail: string;
  transport: IntegrationTransport;
  /** Present (and required) only for the `composio` transport. */
  connectedAccountId?: string;
}

export interface ListInboxOptions {
  /** Gmail pagination cursor. */
  pageToken?: string;
  /** Outlook pagination offset. */
  skip?: number;
  /** Max messages to return (provider may cap lower). */
  limit?: number;
}

export interface InboxPage {
  messages: MailMessage[];
  /** Gmail next-page cursor, when more pages exist. */
  nextPageToken?: string;
  /** Outlook (and generic) "another page exists" flag. */
  hasMore?: boolean;
}

export interface SendInput {
  to: string;
  subject: string;
  body: string;
}

export interface ReplyInput extends SendInput {
  /** Provider message id (or RFC822 Message-ID) being replied to. */
  inReplyTo: string;
  /** Optional RFC822 References header chain (direct providers). */
  references?: string;
  /** Provider thread id, when the transport threads by id (Composio/Outlook). */
  threadId?: string;
}

export interface SendResult {
  /** Provider id of the sent message, when the provider returns one. */
  id?: string;
}

/**
 * Normalized mail provider contract. Every method returns a `Result` — no
 * method throws for an expected provider/auth/network failure. `normalize*`
 * are pure and synchronous: they convert a raw provider payload into the shared
 * shape (used by list/get today, and by cache/sync layers later).
 */
export interface MailAdapter {
  readonly provider: MailProvider;
  readonly transport: IntegrationTransport;

  listInbox(ctx: MailAccountContext, opts?: ListInboxOptions): Promise<Result<InboxPage>>;
  getMessage(ctx: MailAccountContext, messageId: string): Promise<Result<MailMessageFull>>;
  sendMessage(ctx: MailAccountContext, input: SendInput): Promise<Result<SendResult>>;
  replyToMessage(ctx: MailAccountContext, input: ReplyInput): Promise<Result<SendResult>>;
  markRead(ctx: MailAccountContext, messageId: string): Promise<Result<void>>;
  markUnread(ctx: MailAccountContext, messageId: string): Promise<Result<void>>;
  archiveMessage(ctx: MailAccountContext, messageId: string): Promise<Result<void>>;
  deleteMessage(ctx: MailAccountContext, messageId: string): Promise<Result<void>>;

  normalizeMessage(raw: unknown, ctx: MailAccountContext): MailMessage | null;
  normalizeMessageFull(raw: unknown, ctx: MailAccountContext): MailMessageFull | null;
}

/** Build an adapter context from a unified account ref + the user id. */
export function toMailContext(userId: string, account: MailAccountRef): MailAccountContext {
  return {
    userId,
    provider: account.provider,
    mailEmail: account.mailEmail,
    transport: account.via === "composio" ? "composio" : "direct",
    connectedAccountId: account.connectedAccountId,
  };
}
