import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const executeVerifiedComposioTool = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "axis-user-1" } } }) } }),
}));
vi.mock("@/lib/ratelimit", () => ({ redisRateLimit: async () => ({ success: true }) }));
vi.mock("@/lib/integrations/composio", () => ({
  ComposioError: class ComposioError extends Error { constructor(message: string, public status = 502) { super(message); } },
  isSupportedToolkit: (toolkit: string) => toolkit === "gmail" || toolkit === "outlook",
}));
vi.mock("@/lib/integrations/composio-identity", () => ({
  executeVerifiedComposioTool: (...args: unknown[]) => executeVerifiedComposioTool(...args),
  ComposioIdentityError: class ComposioIdentityError extends Error {
    constructor(public code: string, public status: number) { super(code); }
  },
}));
vi.mock("@/lib/integrations/composio-allowlist", () => ({
  isAllowedComposioTool: (toolkit: string, tool: string) => toolkit === "gmail" && tool === "GMAIL_FETCH_EMAILS",
}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

import { POST } from "./route";
import { ComposioIdentityError } from "@/lib/integrations/composio-identity";

function request(body: Record<string, unknown>) {
  return new NextRequest("http://axis.test/api/integrations/composio/execute", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("Composio execute opaque identity boundary", () => {
  beforeEach(() => {
    executeVerifiedComposioTool.mockReset();
  });

  it("requires an opaque local connection id before any provider call", async () => {
    const res = await POST(request({ toolkit: "gmail", tool: "GMAIL_FETCH_EMAILS" }));
    expect(res.status).toBe(422);
    expect(executeVerifiedComposioTool).not.toHaveBeenCalled();
  });

  it("binds the exact local id, authenticated user, and requested toolkit", async () => {
    executeVerifiedComposioTool.mockResolvedValueOnce({ successful: true, error: null });

    const res = await POST(request({
      toolkit: "gmail",
      connectionId: "axis-gmail-connection",
      tool: "GMAIL_FETCH_EMAILS",
    }));

    expect(res.status).toBe(200);
    expect(executeVerifiedComposioTool).toHaveBeenCalledWith({
      userId: "axis-user-1",
      toolkit: "gmail",
      connectionId: "axis-gmail-connection",
      toolSlug: "GMAIL_FETCH_EMAILS",
      arguments: undefined,
    });
  });

  it("fails closed on an owned-but-wrong-toolkit connection without any route fallback", async () => {
    executeVerifiedComposioTool.mockRejectedValueOnce(new ComposioIdentityError("connection_not_found", 404));

    const res = await POST(request({
      toolkit: "gmail",
      connectionId: "axis-outlook-connection",
      tool: "GMAIL_FETCH_EMAILS",
    }));

    expect(res.status).toBe(404);
    expect(executeVerifiedComposioTool).toHaveBeenCalledTimes(1);
  });
});
