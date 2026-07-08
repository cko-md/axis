import { beforeEach, describe, expect, it, vi } from "vitest";

const executeToolMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/integrations/composio", async () => {
  const actual = await vi.importActual<typeof import("@/lib/integrations/composio")>(
    "@/lib/integrations/composio",
  );
  return {
    ...actual,
    executeTool: executeToolMock,
  };
});

import { getComposioMessage } from "./composio";

describe("getComposioMessage() — Gmail", () => {
  beforeEach(() => {
    executeToolMock.mockReset();
  });

  it("calls the verified GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID slug with the confirmed argument schema", async () => {
    executeToolMock.mockResolvedValueOnce({
      successful: true,
      data: {
        id: "msg-1",
        threadId: "thread-1",
        payload: {
          headers: [
            { name: "From", value: "Alice <alice@example.com>" },
            { name: "Subject", value: "Hello" },
          ],
          mimeType: "text/plain",
          body: { data: Buffer.from("hi there", "utf-8").toString("base64") },
        },
        labelIds: ["INBOX"],
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
      toolSlug: "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
      connectedAccountId: "connected-account-1",
      userId: "user-1",
      arguments: { message_id: "msg-1", user_id: "me", format: "full" },
    });
    expect(message).toMatchObject({
      id: "msg-1",
      from: "Alice <alice@example.com>",
      subject: "Hello",
      body: "hi there",
      provider: "gmail",
      accountEmail: "user@gmail.com",
      connectedAccountId: "connected-account-1",
    });
  });

  it("throws a structured ComposioError (never silently 404s) when the tool call fails", async () => {
    executeToolMock.mockResolvedValueOnce({
      successful: false,
      error: "Gmail message fetch failed",
    });

    await expect(
      getComposioMessage("gmail", "connected-account-1", "user-1", "msg-x", "user@gmail.com"),
    ).rejects.toMatchObject({
      message: "Gmail message fetch failed",
      status: 502,
    });
    // Only the one verified slug is attempted — no wasted fallback round-trips.
    expect(executeToolMock).toHaveBeenCalledTimes(1);
  });

  it("returns null when the provider succeeds but the message cannot be normalized", async () => {
    executeToolMock.mockResolvedValueOnce({
      successful: true,
      data: { response_data: {} },
    });

    const message = await getComposioMessage(
      "gmail",
      "connected-account-1",
      "user-1",
      "msg-empty",
      "user@gmail.com",
    );
    expect(message).toBeNull();
  });
});
