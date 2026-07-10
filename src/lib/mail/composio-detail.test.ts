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

  it("unwraps nested envelopes when the outer record lacks body content", async () => {
    executeToolMock.mockResolvedValue({
      successful: true,
      data: {
        id: "msg-outer",
        message: {
          id: "msg-inner",
          payload: {
            headers: [{ name: "Subject", value: "Nested envelope" }],
            parts: [{ mimeType: "text/plain", body: { data: "SW5uZXI=" } }],
          },
        },
      },
    });

    const result = await getComposioMessage("gmail", "ca_1", "user_1", "msg-inner", "user@gmail.com");

    expect(result).toMatchObject({
      id: "msg-inner",
      subject: "Nested envelope",
      body: "Inner",
    });
  });

  it("prefers nested snippet over a sparse outer payload", async () => {
    executeToolMock.mockResolvedValue({
      successful: true,
      data: {
        id: "msg-outer",
        payload: { headers: [{ name: "Subject", value: "Outer subject" }] },
        message: {
          id: "msg-inner",
          snippet: "Nested snippet body",
        },
      },
    });

    const result = await getComposioMessage("gmail", "ca_1", "user_1", "msg-inner", "user@gmail.com");

    expect(result).toMatchObject({
      id: "msg-inner",
      body: "Nested snippet body",
    });
  });

  it("normalizes envelopes that only expose message_id", async () => {
    executeToolMock.mockResolvedValue({
      successful: true,
      data: {
        message_id: "msg-snake",
        subject: "Snake case envelope",
        messageText: "Envelope body",
      },
    });

    const result = await getComposioMessage("gmail", "ca_1", "user_1", "msg-snake", "user@gmail.com");

    expect(result).toMatchObject({
      id: "msg-snake",
      subject: "Snake case envelope",
      body: "Envelope body",
    });
  });

  it("prefers nested id record over sparse message_id wrapper", async () => {
    executeToolMock.mockResolvedValue({
      successful: true,
      data: {
        message_id: "wrapper-only",
        data: {
          id: "msg-real",
          payload: {
            headers: [{ name: "Subject", value: "Real subject" }],
            parts: [{ mimeType: "text/plain", body: { data: "UmVhbCBib2R5" } }],
          },
        },
      },
    });

    const result = await getComposioMessage("gmail", "ca_1", "user_1", "msg-real", "user@gmail.com");

    expect(result).toMatchObject({
      id: "msg-real",
      subject: "Real subject",
      body: "Real body",
    });
  });
});
