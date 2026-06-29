// Composio Gmail adapter. List/read/send go through Composio's tool bridge;
// per-message mutations are declared not_supported until their tool slugs are
// verified live (see docs/architecture/integration-adapters.md). Returns the
// same normalized types + structured errors as the direct adapter, so the
// message-detail route now opens Composio Gmail messages (previously 404'd).

import {
  listComposioInbox,
  getComposioMessage,
  sendComposioMail,
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

function requireConnectedAccount(ctx: MailAccountContext): Result<string> {
  if (!ctx.connectedAccountId) {
    return fail("invalid_request", "Missing Composio connected-account id.", { provider: "gmail", transport: "composio" });
  }
  return ok(ctx.connectedAccountId);
}

const NOT_SUPPORTED = (op: string): Result<void> =>
  fail("not_supported", `Composio Gmail ${op} is not available yet (pending tool-slug verification).`, {
    provider: "gmail",
    transport: "composio",
  });

export const gmailComposioAdapter: MailAdapter = {
  provider: "gmail",
  transport: "composio",

  async listInbox(ctx: MailAccountContext): Promise<Result<InboxPage>> {
    const acct = requireConnectedAccount(ctx);
    if (!acct.ok) return acct;
    try {
      const messages = await listComposioInbox("gmail", acct.data, ctx.userId, ctx.mailEmail);
      return ok({ messages });
    } catch (e) {
      return failFromException(e, "Failed to load Gmail inbox", { provider: "gmail", transport: "composio" });
    }
  },

  async getMessage(ctx: MailAccountContext, messageId: string): Promise<Result<MailMessageFull>> {
    const acct = requireConnectedAccount(ctx);
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
    const acct = requireConnectedAccount(ctx);
    if (!acct.ok) return acct;
    try {
      const res = await sendComposioMail("gmail", acct.data, ctx.userId, input.to, input.subject, input.body);
      if (!res.ok) return fail("provider_error", res.error ?? "Send failed", { provider: "gmail", transport: "composio" });
      return ok({});
    } catch (e) {
      return failFromException(e, "Send failed", { provider: "gmail", transport: "composio" });
    }
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

  markRead(): Promise<Result<void>> { return Promise.resolve(NOT_SUPPORTED("mark-read")); },
  markUnread(): Promise<Result<void>> { return Promise.resolve(NOT_SUPPORTED("mark-unread")); },
  archiveMessage(): Promise<Result<void>> { return Promise.resolve(NOT_SUPPORTED("archive")); },
  deleteMessage(): Promise<Result<void>> { return Promise.resolve(NOT_SUPPORTED("delete")); },

  normalizeMessage(raw: unknown, ctx: MailAccountContext): MailMessage | null {
    return normalizeGmailMessage(raw as Record<string, unknown>, ctx.mailEmail);
  },

  normalizeMessageFull(raw: unknown, ctx: MailAccountContext): MailMessageFull | null {
    return normalizeGmailMessageFull(raw as Record<string, unknown>, ctx.mailEmail);
  },
};
