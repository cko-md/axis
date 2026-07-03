import { beforeEach, describe, expect, it, vi } from "vitest";

const executeToolMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/integrations/composio", async () => {
  const actual = await vi.importActual<typeof import("@/lib/integrations/composio")>("@/lib/integrations/composio");
  return {
    ...actual,
    executeTool: executeToolMock,
  };
});

import { listComposioInbox } from "./composio";

describe("listComposioInbox()", () => {
  beforeEach(() => {
    executeToolMock.mockReset();
  });

  it("throws a structured provider error instead of returning an empty inbox on Composio failure", async () => {
    executeToolMock.mockResolvedValueOnce({
      successful: false,
      error: "Provider unavailable",
    });

    await expect(
      listComposioInbox("gmail", "connected-account-1", "user-1", "user@example.com"),
    ).rejects.toMatchObject({
      message: "Provider unavailable",
      status: 502,
    });
  });
});
