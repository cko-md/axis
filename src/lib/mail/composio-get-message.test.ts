import { beforeEach, describe, expect, it, vi } from "vitest";

const executeToolMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/integrations/composio", async () => {
  const actual = await vi.importActual<typeof import("@/lib/integrations/composio")>("@/lib/integrations/composio");
  return {
    ...actual,
    executeTool: executeToolMock,
  };
});

import { ComposioError } from "@/lib/integrations/composio";
import { GMAIL_GET_MESSAGE_TOOL, getComposioMessage } from "./composio";

describe("getComposioMessage() — Gmail detail", () => {
  beforeEach(() => {
    executeToolMock.mockReset();
  });

  it("uses the verified GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID slug with schema args", async () => {
    executeToolMock.mockResolvedValueOnce({
      successful: true,
      data: {
        id: "msg-1",
        threadId: "thread-1",
        payload: {
          headers: [
            { name: "From", value: "Alice <alice@example.com>" },
            { name: "Subject", value: "Hello" },
            { name: "Date", value: "Thu, 1 Jan 2025 00:00:00 +0000" },
          ],
          parts: [
            {
              mimeType: "text/plain",
              body: { data: "SGVsbG8gd29ybGQ=" },
            },
          ],
        },
      },
    });

    const message = await getComposioMessage(
      "gmail",
      "connected-account-1",
      "user-1",
      "msg-1",
      "user@gmail.com",
    );

    expect(executeToolMock).toHaveBeenCalledTimes(1);
    expect(executeToolMock).toHaveBeenCalledWith({
      toolSlug: GMAIL_GET_MESSAGE_TOOL,
      connectedAccountId: "connected-account-1",
      userId: "user-1",
      arguments: { message_id: "msg-1", user_id: "me", format: "full" },
    });
    expect(message).toMatchObject({
      id: "msg-1",
      from: "Alice <alice@example.com>",
      subject: "Hello",
      body: "Hello world",
      bodyIsHtml: false,
      provider: "gmail",
      accountEmail: "user@gmail.com",
      connectedAccountId: "connected-account-1",
    });
  });

  it("unwraps nested Composio response envelopes before normalizing", async () => {
    executeToolMock.mockResolvedValueOnce({
      successful: true,
      data: {
        data: {
          id: "msg-nested",
          payload: {
            headers: [{ name: "Subject", value: "Nested envelope" }],
            parts: [{ mimeType: "text/html", body: { data: "PHA+SGk8L3A+" } }],
          },
        },
      },
    });

    const message = await getComposioMessage(
      "gmail",
      "connected-account-1",
      "user-1",
      "msg-nested",
      "user@gmail.com",
    );

    expect(message).toMatchObject({
      id: "msg-nested",
      subject: "Nested envelope",
      body: "<p>Hi</p>",
      bodyIsHtml: true,
    });
  });

  it("falls back to top-level headers and flattened Composio body fields", async () => {
    executeToolMock.mockResolvedValueOnce({
      successful: true,
      data: {
        message: {
          id: "msg-flat",
          headers: {
            From: "bob@example.com",
            Subject: "Flat headers",
          },
          messageHtml: "<p>Rendered</p>",
        },
      },
    });

    const message = await getComposioMessage(
      "gmail",
      "connected-account-1",
      "user-1",
      "msg-flat",
      "user@gmail.com",
    );

    expect(message).toMatchObject({
      id: "msg-flat",
      from: "bob@example.com",
      subject: "Flat headers",
      body: "<p>Rendered</p>",
      bodyIsHtml: true,
    });
  });

  it("retries with default format when the first argument variant normalizes to null", async () => {
    executeToolMock
      .mockResolvedValueOnce({
        successful: true,
        data: { message_id: "msg-retry" },
      })
      .mockResolvedValueOnce({
        successful: true,
        data: {
          id: "msg-retry",
          messageText: "Recovered on retry",
        },
      });

    const message = await getComposioMessage(
      "gmail",
      "connected-account-1",
      "user-1",
      "msg-retry",
      "user@gmail.com",
    );

    expect(executeToolMock).toHaveBeenCalledTimes(2);
    expect(executeToolMock.mock.calls[1]?.[0]).toMatchObject({
      toolSlug: GMAIL_GET_MESSAGE_TOOL,
      arguments: { message_id: "msg-retry", user_id: "me" },
    });
    expect(message).toMatchObject({
      id: "msg-retry",
      body: "Recovered on retry",
      bodyIsHtml: false,
    });
  });

  it("throws a structured provider error when every Composio attempt fails", async () => {
    executeToolMock
      .mockResolvedValueOnce({ successful: false, error: "Provider unavailable" })
      .mockResolvedValueOnce({ successful: false, error: "Provider unavailable" });

    await expect(
      getComposioMessage("gmail", "connected-account-1", "user-1", "msg-fail", "user@gmail.com"),
    ).rejects.toBeInstanceOf(ComposioError);
  });

  it("returns null when Composio succeeds but the payload cannot be normalized", async () => {
    executeToolMock
      .mockResolvedValueOnce({ successful: true, data: { threadId: "only-thread" } })
      .mockResolvedValueOnce({ successful: true, data: { threadId: "only-thread" } });

    await expect(
      getComposioMessage("gmail", "connected-account-1", "user-1", "msg-missing", "user@gmail.com"),
    ).resolves.toBeNull();
  });
});
