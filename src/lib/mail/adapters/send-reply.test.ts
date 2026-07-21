import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MailAccountContext } from "./types";

const mocks = vi.hoisted(() => ({
  sendComposioMail: vi.fn(),
  markComposioGmailReadState: vi.fn(),
  archiveComposioGmailMessage: vi.fn(),
  trashComposioGmailMessage: vi.fn(),
}));

vi.mock("../composio", () => ({
  listComposioInbox: vi.fn(),
  getComposioMessage: vi.fn(),
  sendComposioMail: mocks.sendComposioMail,
  markComposioGmailReadState: mocks.markComposioGmailReadState,
  archiveComposioGmailMessage: mocks.archiveComposioGmailMessage,
  trashComposioGmailMessage: mocks.trashComposioGmailMessage,
  normalizeGmailMessage: vi.fn(),
  normalizeGmailMessageFull: vi.fn(),
  normalizeOutlookMessage: vi.fn(),
  normalizeOutlookMessageFull: vi.fn(),
}));

import { gmailComposioAdapter } from "./gmail-composio";
import { outlookComposioAdapter } from "./outlook-composio";

const gmailComposioCtx: MailAccountContext = {
  userId: "user-1",
  provider: "gmail",
  mailEmail: "me@example.com",
  transport: "composio",
  connectedAccountId: "conn-1",
};

const outlookComposioCtx: MailAccountContext = {
  userId: "user-1",
  provider: "outlook",
  mailEmail: "me@example.com",
  transport: "composio",
  connectedAccountId: "conn-2",
};


describe("mail adapter reply parity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns an explicit warning when Composio Gmail replies degrade to send", async () => {
    mocks.sendComposioMail.mockResolvedValueOnce({ ok: true });

    const result = await gmailComposioAdapter.replyToMessage(gmailComposioCtx, {
      to: "you@example.com",
      subject: "Re: Hello",
      body: "Reply",
      inReplyTo: "message-1",
      threadId: "thread-1",
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.data.warning).toMatch(/Composio Gmail threading/);
    expect(mocks.sendComposioMail).toHaveBeenCalledWith(
      "gmail",
      "conn-1",
      "user-1",
      "you@example.com",
      "Re: Hello",
      "Reply",
    );
  });

  it("returns an explicit warning when Composio Outlook replies degrade to send", async () => {
    mocks.sendComposioMail.mockResolvedValueOnce({ ok: true });

    const result = await outlookComposioAdapter.replyToMessage(outlookComposioCtx, {
      to: "you@example.com",
      subject: "Re: Hello",
      body: "Reply",
      inReplyTo: "message-1",
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.data.warning).toMatch(/Composio Outlook threading/);
  });

});
