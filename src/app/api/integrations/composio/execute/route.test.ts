import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";

const executeTool = vi.fn();
const getConnectedAccount = vi.fn();
const memoryRateLimit = vi.fn();
const admit = vi.fn();
const captureRouteError = vi.fn();
const maybeSingle = vi.fn();
const eq = vi.fn();
const query = {
  select: vi.fn(),
  eq,
  maybeSingle: (...args: unknown[]) => maybeSingle(...args),
};
query.select.mockReturnValue(query);
eq.mockReturnValue(query);
const from = vi.fn(() => query);
const CONNECTION_ID = "123e4567-e89b-42d3-a456-426614174000";

vi.mock("@/lib/integrations/composio", () => ({
  executeTool: (...args: unknown[]) => executeTool(...args),
  getConnectedAccount: (...args: unknown[]) => getConnectedAccount(...args),
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
  isReadOnlyComposioTool: (toolkit: string, tool: string) =>
    toolkit === "gmail" && tool === "GMAIL_FETCH_EMAILS",
}));

vi.mock("@/lib/ratelimit", () => ({
  memoryRateLimit: (...args: unknown[]) => memoryRateLimit(...args),
}));
vi.mock("@/lib/admission", () => ({
  ADMISSION_POLICIES: {
    mutation: {
      name: "mutation",
      limit: 30,
      window: "1 m",
      protected: true,
    },
  },
  admit: (...args: unknown[]) => admit(...args),
}));
vi.mock("@/lib/observability/captureRouteError", () => ({
  captureRouteError: (...args: unknown[]) => captureRouteError(...args),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: "user-1" } } }),
    },
    from,
  }),
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
}));

function request(body: Record<string, unknown>) {
  return new NextRequest("http://axis.test/api/integrations/composio/execute", {
    method: "POST",
    body: JSON.stringify({ connectionId: CONNECTION_ID, ...body }),
    headers: { "content-type": "application/json" },
  });
}

describe("POST /api/integrations/composio/execute", () => {
  beforeEach(() => {
    executeTool.mockReset();
    getConnectedAccount.mockReset();
    getConnectedAccount.mockResolvedValue({
      id: "ca-1",
      user_id: "user-1",
      status: "ACTIVE",
      toolkit: { slug: "gmail" },
    });
    admit.mockReset();
    from.mockClear();
    eq.mockClear();
    maybeSingle.mockReset();
    maybeSingle.mockResolvedValue({
      data: { connected_account_id: "ca-1", status: "ACTIVE" },
      error: null,
    });
    memoryRateLimit.mockClear();
    captureRouteError.mockClear();
    admit.mockResolvedValue({ kind: "allowed" });
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
    expect(eq).toHaveBeenCalledWith("id", CONNECTION_ID);
    expect(eq).toHaveBeenCalledWith("user_id", "user-1");
    expect(eq).toHaveBeenCalledWith("toolkit", "gmail");
    expect(eq).toHaveBeenCalledWith("status", "ACTIVE");
  });

  it("dispatches nothing when the explicit connection identity is unresolved", async () => {
    maybeSingle.mockResolvedValueOnce({ data: null, error: null });

    const res = await POST(request({
      toolkit: "gmail",
      tool: "GMAIL_FETCH_EMAILS",
      arguments: {},
    }));

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      error: "CONNECTION_NOT_VERIFIED",
    });
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("maps a provider-declared failure to an observable non-200", async () => {
    executeTool.mockResolvedValueOnce({
      successful: false,
      error: "sensitive upstream detail",
    });

    const res = await POST(request({
      toolkit: "gmail",
      tool: "GMAIL_FETCH_EMAILS",
      arguments: {},
    }));

    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toEqual({
      successful: false,
      error: "PROVIDER_OPERATION_FAILED",
    });
    expect(captureRouteError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ code: "PROVIDER_OPERATION_FAILED" }),
    );
    expect(JSON.stringify(captureRouteError.mock.calls)).not.toContain(
      "sensitive upstream detail",
    );
  });

  it.each([
    ["false", false],
    ["string true", "true"],
    ["missing", undefined],
  ])("requires provider successful to be literal true: %s", async (
    _case,
    successful,
  ) => {
    executeTool.mockResolvedValueOnce(
      successful === undefined ? {} : { successful },
    );

    const res = await POST(request({
      toolkit: "gmail",
      tool: "GMAIL_FETCH_EMAILS",
      arguments: {},
    }));

    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toEqual({
      successful: false,
      error: "PROVIDER_OPERATION_FAILED",
    });
    expect(captureRouteError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ code: "PROVIDER_OPERATION_FAILED" }),
    );
  });

  it("dispatches nothing for a forged local row with a mismatched remote owner", async () => {
    maybeSingle.mockResolvedValueOnce({
      data: { connected_account_id: "ca-forged", status: "ACTIVE" },
      error: null,
    });
    getConnectedAccount.mockResolvedValueOnce({
      id: "ca-forged",
      user_id: "attacker-user",
      status: "ACTIVE",
      toolkit: { slug: "gmail" },
    });

    const res = await POST(request({
      toolkit: "gmail",
      tool: "GMAIL_FETCH_EMAILS",
      arguments: {},
    }));

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      error: "CONNECTION_NOT_VERIFIED",
    });
    expect(getConnectedAccount).toHaveBeenCalledWith("ca-forged");
    expect(executeTool).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: "unavailable", reason: "backend" }, 503],
    [{ kind: "limited", retryAfterSeconds: 19 }, 429],
  ])("stops admission decision %o before lookup, local fallback, or provider dispatch", async (decision, status) => {
    admit.mockResolvedValue(decision);

    const res = await POST(request({
      toolkit: "gmail",
      tool: "GMAIL_FETCH_EMAILS",
      arguments: {},
    }));

    expect(res.status).toBe(status);
    expect(from).not.toHaveBeenCalled();
    expect(memoryRateLimit).not.toHaveBeenCalled();
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("rejects an oversized body before connection lookup or provider dispatch", async () => {
    const res = await POST(request({
      toolkit: "gmail",
      tool: "GMAIL_FETCH_EMAILS",
      arguments: { padding: "x".repeat(70_000) },
    }));

    expect(res.status).toBe(413);
    expect(from).not.toHaveBeenCalled();
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("never exposes or records raw provider exception messages", async () => {
    const sensitive =
      "provider failed email=user@example.test token=server-secret";
    executeTool.mockRejectedValueOnce(new Error(sensitive));

    const res = await POST(request({
      toolkit: "gmail",
      tool: "GMAIL_FETCH_EMAILS",
      arguments: {},
    }));
    const body = await res.text();

    expect(res.status).toBe(502);
    expect(body).not.toContain(sensitive);
    expect(JSON.stringify(captureRouteError.mock.calls)).not.toContain(
      sensitive,
    );
  });
});
