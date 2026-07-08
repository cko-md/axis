import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/integrations/composio", async () => {
  const actual = await vi.importActual<typeof import("@/lib/integrations/composio")>("@/lib/integrations/composio");
  return {
    ...actual,
    executeTool: vi.fn(),
  };
});

import { executeTool } from "@/lib/integrations/composio";
import { getComposioMessage } from "./composio";

const executeToolMock = vi.mocked(executeTool);

describe("getComposioMessage()", () => {
  beforeEach(() => {
    executeToolMock.mockReset();
  });

  it("uses the verified Gmail detail tool slug", async () => {
    executeToolMock.mockResolvedValue({
      successful: true,
      data: {
        id: "msg-1",
        payload: {
          headers: [
            { name: "From", value: "Sender <sender@example.com>" },
            { name: "Subject", value: "Hello" },
            { name: "Date", value: "Thu, 1 Jan 2025 00:00:00 +0000" },
          ],
          parts: [{ mimeType: "text/plain", body: { data: "SGVsbG8gZnJvbSBwYXlsb2Fk" } }],
        },
      },
    });

    const result = await getComposioMessage("gmail", "ca_1", "user_1", "msg-1", "user@gmail.com");

    expect(result).not.toBeNull();
    expect(executeToolMock).toHaveBeenCalledTimes(1);
    expect(executeToolMock).toHaveBeenCalledWith(expect.objectContaining({
      toolSlug: "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
    }));
  });

  it("normalizes wrapped response_data payload shapes", async () => {
    executeToolMock.mockResolvedValue({
      successful: true,
      data: {
        response_data: {
          id: "msg-2",
          headers: {
            from: "Wrapped Sender <sender@example.com>",
            subject: "Wrapped Subject",
            date: "Thu, 1 Jan 2025 00:00:00 +0000",
          },
          message_html: "<p>Wrapped body</p>",
        },
      },
    });

    const result = await getComposioMessage("gmail", "ca_1", "user_1", "msg-2", "user@gmail.com");

    expect(result).toMatchObject({
      id: "msg-2",
      subject: "Wrapped Subject",
      body: "<p>Wrapped body</p>",
      bodyIsHtml: true,
    });
  });
});
