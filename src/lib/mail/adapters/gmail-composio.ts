// Composio Gmail adapter. List/read/send/action calls go through Composio's
// tool bridge and return the same normalized types + structured errors as the
// direct adapter.

import {
  listComposioInbox,
  getComposioMessage,
  normalizeGmailMessage,
  normalizeGmailMessageFull,
} from "../composio";
import type { MailMessage, MailMessageFull } from "../gmail";
import {
  ok,
  fail,
  failFromException,
  type Result,
} from "../../integrations/types";
import type {
  MailAdapter,
  MailAccountContext,
  InboxPage,
  SendInput,
  ReplyInput,
  SendResult,
} from "./types";

function requireConnectionId(ctx: MailAccountContext): Result<string> {
  if (!ctx.connectionId) {
    return fail("invalid_request", "Missing mailbox connection id.", { provider: "gmail", transport: "composio" });
  }
  return ok(ctx.connectionId);
}

export const gmailComposioAdapter: MailAdapter = {
  provider: "gmail",
  transport: "composio",

  async listInbox(ctx: MailAccountContext, opts?: { pageToken?: string; skip?: number }): Promise<Result<InboxPage>> {
    const acct = requireConnectionId(ctx);
    if (!acct.ok) return acct;
    try {
      const page = await listComposioInbox("gmail", acct.data, ctx.userId, ctx.mailEmail, opts);
      return ok({
        messages: page.messages,
        nextPageToken: page.nextPageToken,
        hasMore: page.hasMore ?? Boolean(page.nextPageToken),
      });
    } catch (e) {
      return failFromException(e, "Failed to load Gmail inbox", { provider: "gmail", transport: "composio" });
    }
  },

  async getMessage(ctx: MailAccountContext, messageId: string): Promise<Result<MailMessageFull>> {
    const acct = requireConnectionId(ctx);
    if (!acct.ok) return acct;
    try {
      const message = await getComposioMessage("gmail", acct.data, ctx.userId, messageId, ctx.mailEmail);
      if (!message) return fail("not_found", "Message could not be loaded.", { provider: "gmail", transport: "composio", status: 404 });
      return ok(message);
    } catch (e) {
      return failFromException(e, "Failed to load message", { provider: "gmail", transport: "composio" });
    }
  },

  async sendMessage(ctx: MailAccountContext, input: SendInput): Promise<Result<SendResult>> {
    void ctx;
    void input;
    return fail("not_supported", "Mail send is disabled while provider mutation approval is pending.", { provider: "gmail", transport: "composio" });
  },

  // Composio's send tool doesn't expose threading params we've verified, so a
  // reply is sent as a normal message (subject "Re:" + quoted body come from
  // the caller). Threaded reply is a follow-up once the tool args are confirmed.
  async replyToMessage(ctx: MailAccountContext, input: ReplyInput): Promise<Result<SendResult>> {
    const result = await this.sendMessage(ctx, { to: input.to, subject: input.subject, body: input.body });
    if (!result.ok) return result;
    return ok({
      ...result.data,
      warning: "Reply sent as a new message because Composio Gmail threading is not verified yet.",
    });
  },

  async markRead(ctx: MailAccountContext, messageId: string): Promise<Result<void>> {
    void ctx;
    void messageId;
    return Promise.resolve(fail("not_supported", "Mail mutations are disabled while provider mutation approval is pending.", { provider: "gmail", transport: "composio" }));
  },

  async markUnread(ctx: MailAccountContext, messageId: string): Promise<Result<void>> {
    void ctx;
    void messageId;
    return Promise.resolve(fail("not_supported", "Mail mutations are disabled while provider mutation approval is pending.", { provider: "gmail", transport: "composio" }));
  },

  async archiveMessage(ctx: MailAccountContext, messageId: string): Promise<Result<void>> {
    void ctx;
    void messageId;
    return Promise.resolve(fail("not_supported", "Mail mutations are disabled while provider mutation approval is pending.", { provider: "gmail", transport: "composio" }));
  },

  async deleteMessage(ctx: MailAccountContext, messageId: string): Promise<Result<void>> {
    void ctx;
    void messageId;
    return Promise.resolve(fail("not_supported", "Mail mutations are disabled while provider mutation approval is pending.", { provider: "gmail", transport: "composio" }));
  },

  getAttachment(): Promise<Result<never>> {
    return Promise.resolve(fail("not_supported", "Composio Gmail attachment download is not available yet; reconnect this mailbox directly to save attachments into Library.", {
      provider: "gmail",
      transport: "composio",
    }));
  },

  normalizeMessage(raw: unknown, ctx: MailAccountContext): MailMessage | null {
    return normalizeGmailMessage(raw as Record<string, unknown>, ctx.mailEmail);
  },

  normalizeMessageFull(raw: unknown, ctx: MailAccountContext): MailMessageFull | null {
    return normalizeGmailMessageFull(raw as Record<string, unknown>, ctx.mailEmail);
  },
};
