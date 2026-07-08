import { beforeEach, describe, expect, it, vi } from "vitest";

const executeToolMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/integrations/composio", async () => {
  const actual = await vi.importActual<typeof import("@/lib/integrations/composio")>("@/lib/integrations/composio");
  return {
    ...actual,
    executeTool: executeToolMock,
  };
});

import { OUTLOOK_COMPOSIO_TOOLS } from "@/lib/integrations/composio-mail-tools";
import { sendComposioMail } from "./composio";

describe("sendComposioMail()", () => {
  beforeEach(() => {
    executeToolMock.mockReset();
  });

  it("uses verified Outlook send slug and schema args", async () => {
    executeToolMock.mockResolvedValueOnce({ successful: true, data: {} });

    const result = await sendComposioMail(
      "outlook",
      "connected-account-1",
      "user-1",
      "recipient@example.com",
      "Project update",
      "Hello team",
    );

    expect(result).toEqual({ ok: true });
    expect(executeToolMock).toHaveBeenCalledWith({
      toolSlug: OUTLOOK_COMPOSIO_TOOLS[2],
      connectedAccountId: "connected-account-1",
      userId: "user-1",
      arguments: {
        to: "recipient@example.com",
        subject: "Project update",
        body: "Hello team",
        user_id: "me",
        is_html: false,
        save_to_sent_items: true,
      },
    });
  });

  it("marks Gmail HTML bodies with is_html", async () => {
    executeToolMock.mockResolvedValueOnce({ successful: true, data: {} });

    await sendComposioMail(
      "gmail",
      "connected-account-1",
      "user-1",
      "recipient@example.com",
      "Rendered",
      "<p>Hello</p>",
    );

    expect(executeToolMock).toHaveBeenCalledWith(
      expect.objectContaining({
        toolSlug: "GMAIL_SEND_EMAIL",
        arguments: expect.objectContaining({
          recipient_email: "recipient@example.com",
          is_html: true,
        }),
      }),
    );
  });
});
