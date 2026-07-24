import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const executeTool = vi.fn();
const memoryRateLimit = vi.fn();
const captureMessage = vi.fn();

vi.mock("@/lib/integrations/composio", () => ({
  executeTool: (...args: unknown[]) => executeTool(...args),
  ComposioError: class ComposioError extends Error {
    status: number;
    constructor(message: string, status = 502) {
      super(message);
      this.status = status;
    }
  },
  isSupportedToolkit: (toolkit: string) => ["gmail", "outlook"].includes(toolkit),
}));

vi.mock("@/lib/ratelimit", () => ({
  memoryRateLimit: (...args: unknown[]) => memoryRateLimit(...args),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            eq: async () => ({
              data: [{ connected_account_id: "ca-1", status: "ACTIVE" }],
              error: null,
            }),
          }),
        }),
      }),
    }),
  }),
}));

vi.mock("@sentry/nextjs", () => ({ captureMessage: (...args: unknown[]) => captureMessage(...args) }));

import { POST } from "./route";
import { ComposioError } from "@/lib/integrations/composio";
import { isAllowedComposioTool } from "@/lib/integrations/composio-allowlist";

function request(tool: string) {
  return new NextRequest("http://axis.test/api/integrations/composio/execute", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ toolkit: tool.startsWith("OUTLOOK") ? "outlook" : "gmail", tool }),
  });
}

describe("generic Composio execute containment", () => {
  beforeEach(() => {
    executeTool.mockReset();
    captureMessage.mockReset();
    memoryRateLimit.mockReturnValue({ success: true });
  });

  it("uses the real generic-read-only allowlist so mail mutations never reach executeTool", async () => {
    expect(isAllowedComposioTool("gmail", "GMAIL_SEND_EMAIL", "generic_read_only")).toBe(false);
    expect(isAllowedComposioTool("outlook", "OUTLOOK_SEND_EMAIL", "generic_read_only")).toBe(false);

    for (const tool of ["GMAIL_SEND_EMAIL", "OUTLOOK_SEND_EMAIL"]) {
      const response = await POST(request(tool));
      expect(response.status).toBe(403);
    }
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("permits a generic read and never reflects provider-controlled result errors", async () => {
    executeTool.mockResolvedValueOnce({ successful: false, error: "RAW_PROVIDER_BODY_CANARY" });

    const response = await POST(request("GMAIL_FETCH_EMAILS"));
    expect(response.status).toBe(200);
    expect(executeTool).toHaveBeenCalledOnce();
    await expect(response.json()).resolves.toEqual({
      successful: false,
      error: "Provider tool execution did not succeed",
    });
  });

  it("does not send upstream exception bodies to the response or Sentry", async () => {
    executeTool.mockRejectedValueOnce(new ComposioError("UPSTREAM_BODY_CANARY", 502));

    const response = await POST(request("GMAIL_FETCH_EMAILS"));
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "Provider tool execution failed" });
    expect(JSON.stringify(captureMessage.mock.calls)).not.toContain("UPSTREAM_BODY_CANARY");
    expect(captureMessage).toHaveBeenCalledWith(
      "Composio tool execution failed",
      expect.objectContaining({ tags: expect.objectContaining({ toolkit: "gmail", tool: "GMAIL_FETCH_EMAILS", provider_status: "502" }) }),
    );
  });
});
