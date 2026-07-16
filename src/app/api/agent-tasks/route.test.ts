import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  adminRpc: vi.fn(),
  createAdminClient: vi.fn(),
  captureRouteError: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: mocks.getUser },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: mocks.createAdminClient,
}));
vi.mock("@/lib/observability/captureRouteError", () => ({
  captureRouteError: mocks.captureRouteError,
}));

const task = {
  id: "11111111-1111-4111-8111-111111111111",
  objective: "Review the portfolio",
  status: "queued",
  context: { source: "test" },
  source_routine_id: null,
  source_skill: null,
  estimated_cost_usd: 0.25,
  actual_cost_usd: null,
  created_at: "2026-07-16T12:00:00.000Z",
  updated_at: "2026-07-16T12:00:00.000Z",
  completed_at: null,
};
const activity = {
  id: "22222222-2222-4222-8222-222222222222",
  kind: "status_change",
  detail: { from: null, to: "queued" },
  created_at: "2026-07-16T12:00:00.000Z",
};

function request(overrides: Record<string, unknown> = {}) {
  return new NextRequest("http://axis.test/api/agent-tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      objective: task.objective,
      context: task.context,
      estimated_cost_usd: task.estimated_cost_usd,
      ...overrides,
    }),
  });
}

describe("POST /api/agent-tasks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUser.mockResolvedValue({
      data: { user: { id: "user_1" } },
      error: null,
    });
    mocks.createAdminClient.mockReturnValue({ rpc: mocks.adminRpc });
    mocks.adminRpc.mockResolvedValue({
      data: { task, activity },
      error: null,
    });
  });

  it("creates the task and initial activity through one atomic RPC", async () => {
    const response = await POST(request());

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ task });
    expect(mocks.adminRpc).toHaveBeenCalledWith("create_agent_task", {
      p_context: task.context,
      p_estimated_cost_usd: task.estimated_cost_usd,
      p_objective: task.objective,
      p_source_routine_id: null,
      p_source_skill: null,
      p_source_claim_token: null,
      p_user_id: "user_1",
    });
    expect(mocks.captureRouteError).not.toHaveBeenCalled();
  });

  it("surfaces and captures an atomic task/activity failure", async () => {
    const error = new Error("transaction failed");
    mocks.adminRpc.mockResolvedValue({ data: null, error });

    const response = await POST(request());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "TASK_CREATE_FAILED" });
    expect(mocks.captureRouteError).toHaveBeenCalledWith(
      error,
      expect.objectContaining({
        operation: "create",
        code: "TASK_CREATE_FAILED",
      }),
    );
  });

  it("fails closed when the atomic RPC response omits the activity row", async () => {
    mocks.adminRpc.mockResolvedValue({ data: { task }, error: null });

    const response = await POST(request());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "TASK_CREATE_FAILED" });
    expect(mocks.captureRouteError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "TASK_CREATE_RESULT_INVALID" }),
      expect.objectContaining({ code: "TASK_CREATE_FAILED" }),
    );
  });

  it("rejects an invalid estimated cost before calling the RPC", async () => {
    const response = await POST(request({ estimated_cost_usd: -1 }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "INVALID_ESTIMATED_COST" });
    expect(mocks.adminRpc).not.toHaveBeenCalled();
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
  });

  it("rejects caller-supplied routine provenance instead of persisting a spoof", async () => {
    const response = await POST(request({
      source_skill: "concentration_review",
      source_routine_id: "33333333-3333-4333-8333-333333333333",
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "INVALID_BODY" });
    expect(mocks.adminRpc).not.toHaveBeenCalled();
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
  });

  it("fails visibly when the trusted task service is unavailable", async () => {
    mocks.createAdminClient.mockReturnValue(null);

    const response = await POST(request());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "TASK_SERVICE_NOT_CONFIGURED",
      message: "Task creation is temporarily unavailable.",
    });
    expect(mocks.adminRpc).not.toHaveBeenCalled();
  });
});
