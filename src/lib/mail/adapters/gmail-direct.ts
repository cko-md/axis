// Direct-OAuth Gmail adapter. List/read delegate to the existing lib functions
// (preserving exact, already-working behavior); send + mutations own their REST
// calls here so provider branching leaves the API routes. Every method returns
// a structured Result.

import {
  listGmailInbox,
  getGmailMessage,
  getHeader,
  extractBody,
  type GmailPayload,
  type MailMessage,
  type MailMessageFull,
} from "../gmail";
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

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

function base64UrlEncode(str: string): string {
  return Buffer.from(str).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function buildRfc2822(from: string, to: string, subject: string, body: string, inReplyTo?: string, references?: string): string {
  const lines: string[] = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=UTF-8`,
    `Content-Transfer-Encoding: quoted-printable`,
  ];
  if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`);
  if (references) lines.push(`References: ${references}`);
  lines.push("", body);
  return lines.join("\r\n");
}

/** Token-authenticated Gmail call returning a structured Result. */
async function gmailCall(
  ctx: MailAccountContext,
  path: string,
  init: RequestInit,
): Promise<Result<unknown>> {
  const token = await getFreshMailAccessToken(ctx.userId, "gmail", ctx.mailEmail);
  if (!token) return fail("auth_expired", "Gmail token unavailable — please reconnect.", { provider: "gmail", transport: "direct" });
  try {
    const res = await fetch(`${GMAIL_API}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return failFromStatus(res.status, `Gmail error: ${text.slice(0, 200) || res.statusText}`, { provider: "gmail", transport: "direct" });
    }
    return ok(res.status === 204 ? null : await res.json().catch(() => null));
  } catch (e) {
    return failFromException(e, "Gmail request failed", { provider: "gmail", transport: "direct" });
  }
}

export const gmailDirectAdapter: MailAdapter = {
  provider: "gmail",
  transport: "direct",

  async listInbox(ctx: MailAccountContext, opts?: ListInboxOptions): Promise<Result<InboxPage>> {
    const token = await getFreshMailAccessToken(ctx.userId, "gmail", ctx.mailEmail);
    if (!token) return fail("auth_expired", "Gmail token unavailable — please reconnect.", { provider: "gmail", transport: "direct" });
    try {
      const { messages, nextPageToken } = await listGmailInbox(ctx.userId, ctx.mailEmail, opts?.pageToken);
      return ok({ messages, nextPageToken, hasMore: !!nextPageToken });
    } catch (e) {
      return failFromException(e, "Failed to load Gmail inbox", { provider: "gmail", transport: "direct" });
    }
  },

  async getMessage(ctx: MailAccountContext, messageId: string): Promise<Result<MailMessageFull>> {
    const token = await getFreshMailAccessToken(ctx.userId, "gmail", ctx.mailEmail);
    if (!token) return fail("auth_expired", "Gmail token unavailable — please reconnect.", { provider: "gmail", transport: "direct" });
    try {
      const message = await getGmailMessage(ctx.userId, ctx.mailEmail, messageId);
      if (!message) return fail("not_found", "Message could not be loaded.", { provider: "gmail", transport: "direct", status: 404 });
      return ok(message);
    } catch (e) {
      return failFromException(e, "Failed to load message", { provider: "gmail", transport: "direct" });
    }
  },

  async sendMessage(ctx: MailAccountContext, input: SendInput): Promise<Result<SendResult>> {
    const raw = buildRfc2822(ctx.mailEmail, input.to, input.subject, input.body);
    const res = await gmailCall(ctx, "/messages/send", { method: "POST", body: JSON.stringify({ raw: base64UrlEncode(raw) }) });
    if (!res.ok) return res;
    const data = res.data as { id?: string } | null;
    return ok({ id: data?.id });
  },

  async replyToMessage(ctx: MailAccountContext, input: ReplyInput): Promise<Result<SendResult>> {
    const raw = buildRfc2822(ctx.mailEmail, input.to, input.subject, input.body, input.inReplyTo, input.references);
    const body: Record<string, unknown> = { raw: base64UrlEncode(raw) };
    if (input.threadId) body.threadId = input.threadId;
    const res = await gmailCall(ctx, "/messages/send", { method: "POST", body: JSON.stringify(body) });
    if (!res.ok) return res;
    const data = res.data as { id?: string } | null;
    return ok({ id: data?.id });
  },

  async markRead(ctx: MailAccountContext, messageId: string): Promise<Result<void>> {
    const res = await gmailCall(ctx, `/messages/${encodeURIComponent(messageId)}/modify`, {
      method: "POST",
      body: JSON.stringify({ removeLabelIds: ["UNREAD"] }),
    });
    return res.ok ? ok(undefined) : res;
  },

  async markUnread(ctx: MailAccountContext, messageId: string): Promise<Result<void>> {
    const res = await gmailCall(ctx, `/messages/${encodeURIComponent(messageId)}/modify`, {
      method: "POST",
      body: JSON.stringify({ addLabelIds: ["UNREAD"] }),
    });
    return res.ok ? ok(undefined) : res;
  },

  async archiveMessage(ctx: MailAccountContext, messageId: string): Promise<Result<void>> {
    // Gmail "archive" = remove the INBOX label.
    const res = await gmailCall(ctx, `/messages/${encodeURIComponent(messageId)}/modify`, {
      method: "POST",
      body: JSON.stringify({ removeLabelIds: ["INBOX"] }),
    });
    return res.ok ? ok(undefined) : res;
  },

  async deleteMessage(ctx: MailAccountContext, messageId: string): Promise<Result<void>> {
    // Trash (recoverable) rather than permanent delete.
    const res = await gmailCall(ctx, `/messages/${encodeURIComponent(messageId)}/trash`, { method: "POST" });
    return res.ok ? ok(undefined) : res;
  },

  normalizeMessage(raw: unknown, ctx: MailAccountContext): MailMessage | null {
    const m = raw as Record<string, unknown>;
    if (!m || typeof m.id !== "string") return null;
    const headers = ((m.payload as GmailPayload | undefined)?.headers ?? []) as Array<{ name: string; value: string }>;
    return {
      id: m.id,
      threadId: (m.threadId as string) ?? m.id,
      from: getHeader(headers, "From"),
      subject: getHeader(headers, "Subject") || "(no subject)",
      date: normalizeMailDate(getHeader(headers, "Date") || m.internalDate),
      snippet: (m.snippet as string) ?? "",
      isUnread: ((m.labelIds as string[]) ?? []).includes("UNREAD"),
      provider: "gmail",
      accountEmail: ctx.mailEmail,
    };
  },

  normalizeMessageFull(raw: unknown, ctx: MailAccountContext): MailMessageFull | null {
    const base = this.normalizeMessage(raw, ctx);
    if (!base) return null;
    const payload = (raw as Record<string, unknown>).payload as GmailPayload | undefined;
    const { content, isHtml } = payload ? extractBody(payload) : { content: "", isHtml: false };
    return { ...base, body: content, bodyIsHtml: isHtml };
  },
};
