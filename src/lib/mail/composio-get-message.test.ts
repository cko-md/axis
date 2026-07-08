import { beforeEach, describe, expect, it, vi } from "vitest";

const executeToolMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/integrations/composio", async () => {
  const actual = await vi.importActual<typeof import("@/lib/integrations/composio")>("@/lib/integrations/composio");
  return {
    ...actual,
    executeTool: executeToolMock,
  };
});

import { GMAIL_GET_MESSAGE_TOOL, getComposioMessage, composioMailErrorStatus } from "./composio";
import { gmailComposioAdapter } from "./adapters/gmail-composio";
import type { MailAccountContext } from "./adapters/types";

function b64url(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

const gmailCtx: MailAccountContext = {
  userId: "user-1",
  provider: "gmail",
  mailEmail: "me@example.com",
  transport: "composio",
  connectedAccountId: "conn-1",
};

describe("getComposioMessage() — Gmail", () => {
  beforeEach(() => {
    executeToolMock.mockReset();
  });

  it("calls the verified GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID slug exactly once with the canonical arguments", async () => {
    executeToolMock.mockResolvedValueOnce({
      successful: true,
      data: { id: "msg-1", threadId: "t-1", snippet: "hi" },
    });

    await getComposioMessage("gmail", "conn-1", "user-1", "msg-1", "me@example.com");

    expect(executeToolMock).toHaveBeenCalledTimes(1);
    expect(executeToolMock).toHaveBeenCalledWith({
      toolSlug: GMAIL_GET_MESSAGE_TOOL,
      connectedAccountId: "conn-1",
      userId: "user-1",
      arguments: { message_id: "msg-1", user_id: "me", format: "full" },
    });
  });

  it("does not retry with variant argument shapes after a provider failure", async () => {
    executeToolMock.mockResolvedValue({ successful: false, error: "Internal provider error" });

    await expect(
      getComposioMessage("gmail", "conn-1", "user-1", "msg-1", "me@example.com"),
    ).rejects.toMatchObject({ status: 502 });
    expect(executeToolMock).toHaveBeenCalledTimes(1);
  });

  it("normalizes a native Gmail full payload (headers + base64url body)", async () => {
    executeToolMock.mockResolvedValueOnce({
      successful: true,
      data: {
        id: "msg-native",
        threadId: "thread-native",
        labelIds: ["INBOX", "UNREAD"],
        snippet: "Native snippet",
        payload: {
          mimeType: "multipart/alternative",
          headers: [
            { name: "From", value: "Alice <alice@example.com>" },
            { name: "Subject", value: "Native shape" },
            { name: "Date", value: "Thu, 1 Jan 2025 00:00:00 +0000" },
          ],
          parts: [
            { mimeType: "text/plain", body: { data: b64url("plain body") } },
            { mimeType: "text/html; charset=UTF-8", body: { data: b64url("<p>html body</p>") } },
          ],
        },
      },
    });

    const message = await getComposioMessage("gmail", "conn-1", "user-1", "msg-native", "me@example.com");

    expect(message).toMatchObject({
      id: "msg-native",
      threadId: "thread-native",
      from: "Alice <alice@example.com>",
      subject: "Native shape",
      snippet: "Native snippet",
      isUnread: true,
      body: "<p>html body</p>",
      bodyIsHtml: true,
      connectedAccountId: "conn-1",
    });
  });

  it("normalizes Composio's flattened shape (sender/messageText/attachmentList) nested under data wrappers", async () => {
    executeToolMock.mockResolvedValueOnce({
      successful: true,
      data: {
        response_data: {
          messageId: "msg-flat",
          threadId: "thread-flat",
          sender: "Bob <bob@example.com>",
          subject: "Flattened shape",
          messageTimestamp: "2025-01-01T00:00:00Z",
          messageText: "Plain text body",
          attachmentList: [
            { attachmentId: "att-1", filename: "report.pdf", mimeType: "application/pdf" },
          ],
        },
      },
    });

    const message = await getComposioMessage("gmail", "conn-1", "user-1", "msg-flat", "me@example.com");

    expect(message).toMatchObject({
      id: "msg-flat",
      from: "Bob <bob@example.com>",
      subject: "Flattened shape",
      date: "2025-01-01T00:00:00.000Z",
      body: "Plain text body",
      bodyIsHtml: false,
    });
    expect(message?.attachments).toEqual([
      {
        id: "att-1",
        filename: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: null,
        inline: false,
      },
    ]);
  });

  it("unwraps nested data envelopes and flat header maps", async () => {
    executeToolMock.mockResolvedValueOnce({
      successful: true,
      data: {
        data: {
          id: "msg-nested",
          headers: {
            From: "carol@example.com",
            Subject: "Nested envelope",
          },
          messageHtml: "<p>Rendered</p>",
        },
      },
    });

    const message = await getComposioMessage("gmail", "conn-1", "user-1", "msg-nested", "me@example.com");

    expect(message).toMatchObject({
      id: "msg-nested",
      from: "carol@example.com",
      subject: "Nested envelope",
      body: "<p>Rendered</p>",
      bodyIsHtml: true,
    });
  });

  it("throws a 404-status ComposioError for a genuine not-found so the route returns not_found (not 502)", async () => {
    executeToolMock.mockResolvedValueOnce({
      successful: false,
      error: "Requested entity was not found.",
    });

    await expect(
      getComposioMessage("gmail", "conn-1", "user-1", "gone", "me@example.com"),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("returns null when the tool succeeds but no message record is present", async () => {
    executeToolMock.mockResolvedValueOnce({ successful: true, data: {} });

    const message = await getComposioMessage("gmail", "conn-1", "user-1", "empty", "me@example.com");
    expect(message).toBeNull();
  });
});

describe("composioMailErrorStatus()", () => {
  it("maps not-found errors to 404", () => {
    expect(composioMailErrorStatus("Requested entity was not found.")).toBe(404);
    expect(composioMailErrorStatus("Message not found")).toBe(404);
  });

  it("maps auth errors to 401", () => {
    expect(composioMailErrorStatus("Unauthorized")).toBe(401);
    expect(composioMailErrorStatus("invalid_grant: token has been expired or revoked")).toBe(401);
  });

  it("maps throttling errors to 429", () => {
    expect(composioMailErrorStatus("Rate limit exceeded")).toBe(429);
    expect(composioMailErrorStatus("Too many requests")).toBe(429);
  });

  it("keeps unrecognized errors at 502", () => {
    expect(composioMailErrorStatus("Something else broke")).toBe(502);
  });
});

describe("gmailComposioAdapter.getMessage() — structured results end to end", () => {
  beforeEach(() => {
    executeToolMock.mockReset();
  });

  it("returns ok with the normalized message on success", async () => {
    executeToolMock.mockResolvedValueOnce({
      successful: true,
      data: {
        id: "msg-ok",
        payload: {
          headers: [{ name: "Subject", value: "Adapter happy path" }],
          mimeType: "text/plain",
          body: { data: b64url("body text") },
        },
      },
    });

    const result = await gmailComposioAdapter.getMessage(gmailCtx, "msg-ok");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.subject).toBe("Adapter happy path");
      expect(result.data.body).toBe("body text");
    }
  });

  it("maps a Composio not-found failure onto the not_found error code", async () => {
    executeToolMock.mockResolvedValueOnce({
      successful: false,
      error: "Requested entity was not found.",
    });

    const result = await gmailComposioAdapter.getMessage(gmailCtx, "gone");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("not_found");
      expect(result.error.status).toBe(404);
    }
  });

  it("maps an expired-auth failure onto auth_expired so the UI prompts reconnect", async () => {
    executeToolMock.mockResolvedValueOnce({
      successful: false,
      error: "invalid_grant: Token has been expired or revoked.",
    });

    const result = await gmailComposioAdapter.getMessage(gmailCtx, "msg-auth");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("auth_expired");
      expect(result.error.status).toBe(401);
    }
  });

  it("keeps unclassified provider failures as retryable provider_error", async () => {
    executeToolMock.mockResolvedValueOnce({
      successful: false,
      error: "Upstream exploded",
    });

    const result = await gmailComposioAdapter.getMessage(gmailCtx, "msg-boom");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("provider_error");
      expect(result.error.retryable).toBe(true);
    }
  });
});
