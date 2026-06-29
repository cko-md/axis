// Direct-OAuth Outlook adapter. Mirrors the Gmail-direct adapter: list/read
// delegate to existing lib functions; send + mutations own their Graph calls.

import {
  listOutlookInbox,
  getOutlookMessage,
} from "../outlook";
import type { MailMessage, MailMessageFull } from "../gmail";
import { normalizeMailDate } from "../dates";
import { getFreshMailAccessToken } from "../tokens";
import {
  ok,
  fail,
  failFromStatus,
  failFromException,
  type Result,
} from "../../integrations/types";
import type {
  MailAdapter,
  MailAccountContext,
  ListInboxOptions,
  InboxPage,
  SendInput,
  ReplyInput,
  SendResult,
} from "./types";

const GRAPH_API = "https://graph.microsoft.com/v1.0/me";

function formatSender(m: Record<string, unknown>): string {
  const ea = (m.from as { emailAddress?: { name?: string; address?: string } } | undefined)?.emailAddress;
  if (!ea) return "";
  return ea.name ? `${ea.name} <${ea.address}>` : ea.address ?? "";
}

async function graphCall(
  ctx: MailAccountContext,
  path: string,
  init: RequestInit,
): Promise<Result<unknown>> {
  const token = await getFreshMailAccessToken(ctx.userId, "outlook", ctx.mailEmail);
  if (!token) return fail("auth_expired", "Outlook token unavailable — please reconnect.", { provider: "outlook", transport: "direct" });
  try {
    const res = await fetch(`${GRAPH_API}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return failFromStatus(res.status, `Outlook error: ${text.slice(0, 200) || res.statusText}`, { provider: "outlook", transport: "direct" });
    }
    return ok(res.status === 204 || res.status === 202 ? null : await res.json().catch(() => null));
  } catch (e) {
    return failFromException(e, "Outlook request failed", { provider: "outlook", transport: "direct" });
  }
}

async function sendMailGraph(ctx: MailAccountContext, input: SendInput): Promise<Result<SendResult>> {
  const res = await graphCall(ctx, "/sendMail", {
    method: "POST",
    body: JSON.stringify({
      message: {
        subject: input.subject,
        body: { contentType: "Text", content: input.body },
        toRecipients: [{ emailAddress: { address: input.to } }],
      },
      saveToSentItems: true,
    }),
  });
  return res.ok ? ok({}) : res;
}

export const outlookDirectAdapter: MailAdapter = {
  provider: "outlook",
  transport: "direct",

  async listInbox(ctx: MailAccountContext, opts?: ListInboxOptions): Promise<Result<InboxPage>> {
    const token = await getFreshMailAccessToken(ctx.userId, "outlook", ctx.mailEmail);
    if (!token) return fail("auth_expired", "Outlook token unavailable — please reconnect.", { provider: "outlook", transport: "direct" });
    try {
      const { messages, hasMore } = await listOutlookInbox(ctx.userId, ctx.mailEmail, opts?.skip ?? 0);
      return ok({ messages, hasMore });
    } catch (e) {
      return failFromException(e, "Failed to load Outlook inbox", { provider: "outlook", transport: "direct" });
    }
  },

  async getMessage(ctx: MailAccountContext, messageId: string): Promise<Result<MailMessageFull>> {
    const token = await getFreshMailAccessToken(ctx.userId, "outlook", ctx.mailEmail);
    if (!token) return fail("auth_expired", "Outlook token unavailable — please reconnect.", { provider: "outlook", transport: "direct" });
    try {
      const message = await getOutlookMessage(ctx.userId, ctx.mailEmail, messageId);
      if (!message) return fail("not_found", "Message could not be loaded.", { provider: "outlook", transport: "direct", status: 404 });
      return ok(message);
    } catch (e) {
      return failFromException(e, "Failed to load message", { provider: "outlook", transport: "direct" });
    }
  },

  sendMessage(ctx: MailAccountContext, input: SendInput): Promise<Result<SendResult>> {
    return sendMailGraph(ctx, input);
  },

  async replyToMessage(ctx: MailAccountContext, input: ReplyInput): Promise<Result<SendResult>> {
    const res = await graphCall(ctx, `/messages/${encodeURIComponent(input.inReplyTo)}/reply`, {
      method: "POST",
      body: JSON.stringify({ comment: input.body }),
    });
    return res.ok ? ok({}) : res;
  },

  async markRead(ctx: MailAccountContext, messageId: string): Promise<Result<void>> {
    const res = await graphCall(ctx, `/messages/${encodeURIComponent(messageId)}`, {
      method: "PATCH",
      body: JSON.stringify({ isRead: true }),
    });
    return res.ok ? ok(undefined) : res;
  },

  async markUnread(ctx: MailAccountContext, messageId: string): Promise<Result<void>> {
    const res = await graphCall(ctx, `/messages/${encodeURIComponent(messageId)}`, {
      method: "PATCH",
      body: JSON.stringify({ isRead: false }),
    });
    return res.ok ? ok(undefined) : res;
  },

  async archiveMessage(ctx: MailAccountContext, messageId: string): Promise<Result<void>> {
    // Move to the well-known "archive" folder.
    const res = await graphCall(ctx, `/messages/${encodeURIComponent(messageId)}/move`, {
      method: "POST",
      body: JSON.stringify({ destinationId: "archive" }),
    });
    return res.ok ? ok(undefined) : res;
  },

  async deleteMessage(ctx: MailAccountContext, messageId: string): Promise<Result<void>> {
    // DELETE moves the message to Deleted Items (recoverable).
    const res = await graphCall(ctx, `/messages/${encodeURIComponent(messageId)}`, { method: "DELETE" });
    return res.ok ? ok(undefined) : res;
  },

  normalizeMessage(raw: unknown, ctx: MailAccountContext): MailMessage | null {
    const m = raw as Record<string, unknown>;
    if (!m || typeof m.id !== "string") return null;
    return {
      id: m.id,
      threadId: (m.conversationId as string) ?? m.id,
      from: formatSender(m),
      subject: (m.subject as string) || "(no subject)",
      date: normalizeMailDate(m.receivedDateTime),
      snippet: (m.bodyPreview as string) ?? "",
      isUnread: m.isRead === false,
      provider: "outlook",
      accountEmail: ctx.mailEmail,
    };
  },

  normalizeMessageFull(raw: unknown, ctx: MailAccountContext): MailMessageFull | null {
    const base = this.normalizeMessage(raw, ctx);
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
