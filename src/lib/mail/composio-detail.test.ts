import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAIL_COMPOSIO_TOOLS } from "@/lib/integrations/composio-mail-tools";

const executeToolMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/integrations/composio", async () => {
  const actual = await vi.importActual<typeof import("@/lib/integrations/composio")>("@/lib/integrations/composio");
  return {
    ...actual,
    executeTool: executeToolMock,
  };
});

import { getComposioMessage, normalizeGmailMessageFull } from "./composio";

function b64url(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

describe("Composio Gmail message detail", () => {
  beforeEach(() => {
    executeToolMock.mockReset();
  });

  it("uses the verified Gmail detail tool slug and unwraps nested message responses", async () => {
    executeToolMock.mockResolvedValueOnce({
      successful: true,
      data: {
        data: {
          message: {
            id: "msg-1",
            threadId: "thread-1",
            payload: {
              mimeType: "text/html",
              headers: {
                From: "Sender <sender@example.com>",
                Subject: "Nested object headers",
                Date: "Wed, 08 Jul 2026 14:00:00 +0000",
              },
              body: { data: b64url("<p>Nested body</p>") },
            },
            labelIds: ["INBOX", "UNREAD"],
            snippet: "Nested body",
          },
        },
      },
    });

    const message = await getComposioMessage("gmail", "connected-account-1", "user-1", "msg-1", "me@example.com");

    expect(message).toMatchObject({
      id: "msg-1",
      threadId: "thread-1",
      from: "Sender <sender@example.com>",
      subject: "Nested object headers",
      body: "<p>Nested body</p>",
      bodyIsHtml: true,
      isUnread: true,
      connectedAccountId: "connected-account-1",
    });
    expect(executeToolMock).toHaveBeenCalledTimes(1);
    expect(executeToolMock).toHaveBeenCalledWith(expect.objectContaining({
      toolSlug: "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
      connectedAccountId: "connected-account-1",
      userId: "user-1",
      arguments: { message_id: "msg-1", user_id: "me", format: "full" },
    }));

    const gmailTools: readonly string[] = MAIL_COMPOSIO_TOOLS.gmail;
    expect(gmailTools).toContain("GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID");
    expect(gmailTools).not.toContain("GMAIL_GET_MESSAGE");
  });

  it("normalizes flattened Gmail headers and HTML body objects", () => {
    const message = normalizeGmailMessageFull({
      message_id: "msg-2",
      thread_id: "thread-2",
      headers: [
        { key: "from", value: "Flattened <flat@example.com>" },
        { key: "subject", value: "Flattened headers" },
        { key: "date", value: "Wed, 08 Jul 2026 15:00:00 +0000" },
      ],
      body: {
        html: "<div>Flattened HTML</div>",
        content_type: "text/html",
      },
      labels: ["inbox", "unread"],
      bodyPreview: "Flattened HTML",
    }, "me@example.com", "connected-account-2");

    expect(message).toMatchObject({
      id: "msg-2",
      threadId: "thread-2",
      from: "Flattened <flat@example.com>",
      subject: "Flattened headers",
      body: "<div>Flattened HTML</div>",
      bodyIsHtml: true,
      isUnread: true,
      connectedAccountId: "connected-account-2",
    });
  });

  it("normalizes object sender fields and Gmail-style body data outside payload", () => {
    const message = normalizeGmailMessageFull({
      id: "msg-3",
      sender: {
        name: "Object Sender",
        email: "object@example.com",
      },
      subject: "Object body",
      body: {
        data: b64url("Plain body from object data"),
        mime_type: "text/plain",
      },
    }, "me@example.com");

    expect(message).toMatchObject({
      id: "msg-3",
      threadId: "msg-3",
      from: "Object Sender <object@example.com>",
      subject: "Object body",
      body: "Plain body from object data",
      bodyIsHtml: false,
    });
  });
});
