import { beforeEach, describe, expect, it, vi } from "vitest";

const executeToolMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/integrations/composio", async () => {
  const actual = await vi.importActual<typeof import("@/lib/integrations/composio")>("@/lib/integrations/composio");
  return {
    ...actual,
    executeTool: executeToolMock,
  };
});

import { getComposioMessage } from "./composio";

function b64url(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// Real GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID output shape, confirmed against
// Composio's /tools/{slug} schema endpoint (see composio.ts comments):
// { messageId, threadId, sender, subject, messageTimestamp, messageText,
//   payload, attachmentList, labelIds, preview }
const GMAIL_MESSAGE_BODY = {
  messageId: "19b11732c1b578fd",
  threadId: "thread-1",
  sender: "alice@example.com",
  subject: "Quarterly update",
  messageTimestamp: "2025-06-01T12:00:00Z",
  labelIds: ["INBOX", "UNREAD"],
  payload: {
    mimeType: "multipart/mixed",
    headers: [
      { name: "From", value: "Alice <alice@example.com>" },
      { name: "Subject", value: "Quarterly update" },
      { name: "Date", value: "Sun, 1 Jun 2025 12:00:00 +0000" },
    ],
    parts: [
      {
        mimeType: "text/html",
        body: { data: b64url("<p>Numbers look good</p>") },
      },
      {
        mimeType: "application/pdf",
        filename: "report.pdf",
        body: { attachmentId: "att-1", size: 4096 },
      },
    ],
  },
  attachmentList: [
    { attachmentId: "att-1", filename: "report.pdf", mimeType: "application/pdf", size: 4096 },
  ],
};

describe("getComposioMessage() — Gmail (verified slug)", () => {
  beforeEach(() => {
    executeToolMock.mockReset();
  });

  it("calls the single verified tool slug with the confirmed argument shape, exactly once", async () => {
    executeToolMock.mockResolvedValueOnce({ successful: true, data: GMAIL_MESSAGE_BODY });

    await getComposioMessage("gmail", "connected-account-1", "user-1", "19b11732c1b578fd", "user@example.com");

    expect(executeToolMock).toHaveBeenCalledTimes(1);
    expect(executeToolMock).toHaveBeenCalledWith({
      toolSlug: "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
      connectedAccountId: "connected-account-1",
      userId: "user-1",
      arguments: { message_id: "19b11732c1b578fd", user_id: "me", format: "full" },
    });
  });

  it("never falls back to the retired GMAIL_GET_MESSAGE slug", async () => {
    executeToolMock.mockResolvedValueOnce({ successful: true, data: GMAIL_MESSAGE_BODY });

    await getComposioMessage("gmail", "connected-account-1", "user-1", "19b11732c1b578fd", "user@example.com");

    const calledSlugs = executeToolMock.mock.calls.map((call) => call[0].toolSlug);
    expect(calledSlugs).toEqual(["GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID"]);
    expect(calledSlugs).not.toContain("GMAIL_GET_MESSAGE");
  });

  it("normalizes the confirmed MessageBody shape into a full MailMessage, including headers/body/attachments", async () => {
    executeToolMock.mockResolvedValueOnce({ successful: true, data: GMAIL_MESSAGE_BODY });

    const message = await getComposioMessage("gmail", "connected-account-1", "user-1", "19b11732c1b578fd", "user@example.com");

    expect(message).toMatchObject({
      id: "19b11732c1b578fd",
      threadId: "thread-1",
      from: "Alice <alice@example.com>",
      subject: "Quarterly update",
      isUnread: true,
      body: "<p>Numbers look good</p>",
      bodyIsHtml: true,
      attachments: [
        expect.objectContaining({ id: "att-1", filename: "report.pdf", mimeType: "application/pdf", sizeBytes: 4096 }),
      ],
    });
  });

  it("throws a structured ComposioError (single attempt, no retries) when Composio reports failure", async () => {
    executeToolMock.mockResolvedValueOnce({ successful: false, error: "invalid_argument: message_id malformed" });

    await expect(
      getComposioMessage("gmail", "connected-account-1", "user-1", "bad-id", "user@example.com"),
    ).rejects.toMatchObject({ message: "invalid_argument: message_id malformed", status: 502 });
    expect(executeToolMock).toHaveBeenCalledTimes(1);
  });

  it("returns null (not-found) when the tool succeeds but the payload has no id/messageId", async () => {
    executeToolMock.mockResolvedValueOnce({ successful: true, data: { subject: "No id here" } });

    const message = await getComposioMessage("gmail", "connected-account-1", "user-1", "msg-1", "user@example.com");
    expect(message).toBeNull();
  });

  it("falls back to attachmentList when the MIME payload yields no attachments (e.g. lighter format)", async () => {
    executeToolMock.mockResolvedValueOnce({
      successful: true,
      data: {
        messageId: "msg-no-parts",
        sender: "bob@example.com",
        subject: "No parts",
        messageText: "Plain body",
        attachmentList: [{ attachmentId: "att-9", filename: "notes.txt", mimeType: "text/plain", size: 12 }],
      },
    });

    const message = await getComposioMessage("gmail", "connected-account-1", "user-1", "msg-no-parts", "user@example.com");
    expect(message?.attachments).toEqual([
      expect.objectContaining({ id: "att-9", filename: "notes.txt", mimeType: "text/plain", sizeBytes: 12 }),
    ]);
  });
});

describe("getComposioMessage() — Outlook (unverified slug, defensive fallback retained)", () => {
  beforeEach(() => {
    executeToolMock.mockReset();
  });

  it("still tries multiple argument variants until one succeeds", async () => {
    executeToolMock
      .mockResolvedValueOnce({ successful: false, error: "bad args #1" })
      .mockResolvedValueOnce({ successful: true, data: { id: "outlook-1", subject: "Hi" } });

    const message = await getComposioMessage("outlook", "connected-account-2", "user-1", "outlook-1", "user@outlook.example");

    expect(message).toMatchObject({ id: "outlook-1", subject: "Hi" });
    expect(executeToolMock).toHaveBeenCalledTimes(2);
    expect(executeToolMock.mock.calls[0][0]).toMatchObject({ toolSlug: "OUTLOOK_OUTLOOK_GET_MESSAGE" });
  });

  it("throws a structured ComposioError after exhausting all argument variants", async () => {
    executeToolMock.mockResolvedValue({ successful: false, error: "not found" });

    await expect(
      getComposioMessage("outlook", "connected-account-2", "user-1", "missing", "user@outlook.example"),
    ).rejects.toMatchObject({ message: "not found", status: 502 });
  });
});
