import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";

const executeTool = vi.fn();
const memoryRateLimit = vi.fn();

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

vi.mock("@/lib/integrations/composio-allowlist", () => ({
  isAllowedComposioTool: (toolkit: string, tool: string) =>
    toolkit === "gmail" && tool === "GMAIL_FETCH_EMAILS",
}));

vi.mock("@/lib/ratelimit", () => ({
  memoryRateLimit: (...args: unknown[]) => memoryRateLimit(...args),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: "user-1" } } }),
    },
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

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
}));

function request(body: Record<string, unknown>) {
  return new NextRequest("http://axis.test/api/integrations/composio/execute", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("POST /api/integrations/composio/execute", () => {
  beforeEach(() => {
    executeTool.mockReset();
    memoryRateLimit.mockReturnValue({ success: true });
  });

  it("rejects tools outside the allowlist", async () => {
    const res = await POST(request({ toolkit: "gmail", tool: "GMAIL_DELETE_ALL_EMAILS" }));
    expect(res.status).toBe(403);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("returns only successful + error fields from provider execution", async () => {
    executeTool.mockResolvedValueOnce({
      successful: true,
      error: null,
      data: { secret: "must-not-leak" },
    });
    const res = await POST(request({ toolkit: "gmail", tool: "GMAIL_FETCH_EMAILS", arguments: {} }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ successful: true, error: null });
  });
});
