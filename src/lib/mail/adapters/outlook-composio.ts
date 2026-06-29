// Composio Outlook adapter — same contract + behavior model as the Composio
// Gmail adapter. List/read/send wired; per-message mutations not_supported
// until tool slugs are verified live.

import {
  listComposioInbox,
  getComposioMessage,
  sendComposioMail,
  normalizeOutlookMessage,
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
    return fail("invalid_request", "Missing Composio connected-account id.", { provider: "outlook", transport: "composio" });
  }
  return ok(ctx.connectedAccountId);
}

const NOT_SUPPORTED = (op: string): Result<void> =>
  fail("not_supported", `Composio Outlook ${op} is not available yet (pending tool-slug verification).`, {
    provider: "outlook",
    transport: "composio",
  });

export const outlookComposioAdapter: MailAdapter = {
  provider: "outlook",
  transport: "composio",

  async listInbox(ctx: MailAccountContext): Promise<Result<InboxPage>> {
    const acct = requireConnectedAccount(ctx);
    if (!acct.ok) return acct;
    try {
      const messages = await listComposioInbox("outlook", acct.data, ctx.userId, ctx.mailEmail);
      return ok({ messages });
    } catch (e) {
      return failFromException(e, "Failed to load Outlook inbox", { provider: "outlook", transport: "composio" });
    }
  },

  async getMessage(ctx: MailAccountContext, messageId: string): Promise<Result<MailMessageFull>> {
    const acct = requireConnectedAccount(ctx);
    if (!acct.ok) return acct;
    try {
      const message = await getComposioMessage("outlook", acct.data, ctx.userId, messageId, ctx.mailEmail);
      if (!message) return fail("not_found", "Message could not be loaded.", { provider: "outlook", transport: "composio", status: 404 });
      return ok(message);
    } catch (e) {
      return failFromException(e, "Failed to load message", { provider: "outlook", transport: "composio" });
    }
  },

  async sendMessage(ctx: MailAccountContext, input: SendInput): Promise<Result<SendResult>> {
    const acct = requireConnectedAccount(ctx);
    if (!acct.ok) return acct;
    try {
      const res = await sendComposioMail("outlook", acct.data, ctx.userId, input.to, input.subject, input.body);
      if (!res.ok) return fail("provider_error", res.error ?? "Send failed", { provider: "outlook", transport: "composio" });
      return ok({});
    } catch (e) {
      return failFromException(e, "Send failed", { provider: "outlook", transport: "composio" });
    }
  },

  async replyToMessage(ctx: MailAccountContext, input: ReplyInput): Promise<Result<SendResult>> {
    const result = await this.sendMessage(ctx, { to: input.to, subject: input.subject, body: input.body });
    if (!result.ok) return result;
    return ok({
      ...result.data,
      warning: "Reply sent as a new message because Composio Outlook threading is not verified yet.",
    });
  },

  markRead(): Promise<Result<void>> { return Promise.resolve(NOT_SUPPORTED("mark-read")); },
  markUnread(): Promise<Result<void>> { return Promise.resolve(NOT_SUPPORTED("mark-unread")); },
  archiveMessage(): Promise<Result<void>> { return Promise.resolve(NOT_SUPPORTED("archive")); },
  deleteMessage(): Promise<Result<void>> { return Promise.resolve(NOT_SUPPORTED("delete")); },

  normalizeMessage(raw: unknown, ctx: MailAccountContext): MailMessage | null {
    return normalizeOutlookMessage(raw as Record<string, unknown>, ctx.mailEmail);
  },

  normalizeMessageFull(raw: unknown, ctx: MailAccountContext): MailMessageFull | null {
    const base = normalizeOutlookMessage(raw as Record<string, unknown>, ctx.mailEmail);
    if (!base) return null;
    const m = raw as Record<string, unknown>;
    const bodyObj = m.body as { content?: string; contentType?: string } | undefined;
    return {
      ...base,
      body: bodyObj?.content ?? (m.bodyPreview as string) ?? "",
      bodyIsHtml: (bodyObj?.contentType ?? "").toLowerCase() === "html",
    };
  },
};
