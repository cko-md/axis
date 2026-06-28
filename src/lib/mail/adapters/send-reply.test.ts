import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MailAccountContext } from "./types";

const mocks = vi.hoisted(() => ({
  sendComposioMail: vi.fn(),
  getFreshMailAccessToken: vi.fn(),
}));

vi.mock("../composio", () => ({
  listComposioInbox: vi.fn(),
  getComposioMessage: vi.fn(),
  sendComposioMail: mocks.sendComposioMail,
  normalizeGmailMessage: vi.fn(),
  normalizeOutlookMessage: vi.fn(),
}));

vi.mock("../tokens", () => ({
  getFreshMailAccessToken: mocks.getFreshMailAccessToken,
}));

import { gmailComposioAdapter } from "./gmail-composio";
import { outlookComposioAdapter } from "./outlook-composio";
import { outlookDirectAdapter } from "./outlook-direct";

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

const outlookDirectCtx: MailAccountContext = {
  userId: "user-1",
  provider: "outlook",
  mailEmail: "me@example.com",
  transport: "direct",
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

  it("uses Microsoft Graph native reply for direct Outlook replies", async () => {
    mocks.getFreshMailAccessToken.mockResolvedValueOnce("token");
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await outlookDirectAdapter.replyToMessage(outlookDirectCtx, {
      to: "you@example.com",
      subject: "Re: Hello",
      body: "Reply body",
      inReplyTo: "message-1",
    });

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://graph.microsoft.com/v1.0/me/messages/message-1/reply",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ comment: "Reply body" }),
      }),
    );
  });
});
