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
  connectionId: "axis-conn-1",
};

const outlookComposioCtx: MailAccountContext = {
  userId: "user-1",
  provider: "outlook",
  mailEmail: "me@example.com",
  transport: "composio",
  connectionId: "axis-conn-2",
};


describe("mail adapter reply parity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps Composio Gmail replies disabled pending the mutation approval kernel", async () => {

    const result = await gmailComposioAdapter.replyToMessage(gmailComposioCtx, {
      to: "you@example.com",
      subject: "Re: Hello",
      body: "Reply",
      inReplyTo: "message-1",
      threadId: "thread-1",
    });

    expect(result.ok).toBe(false);
    expect(mocks.sendComposioMail).not.toHaveBeenCalled();
  });

  it("keeps Composio Outlook replies disabled pending the mutation approval kernel", async () => {

    const result = await outlookComposioAdapter.replyToMessage(outlookComposioCtx, {
      to: "you@example.com",
      subject: "Re: Hello",
      body: "Reply",
      inReplyTo: "message-1",
    });

    expect(result.ok).toBe(false);
    expect(mocks.sendComposioMail).not.toHaveBeenCalled();
  });

});
