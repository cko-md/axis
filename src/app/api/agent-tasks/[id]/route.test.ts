import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { PATCH } from "./route";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  from: vi.fn(),
  rpc: vi.fn(),
  captureRouteError: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: mocks.getUser },
    from: mocks.from,
    rpc: mocks.rpc,
  }),
}));
vi.mock("@/lib/observability/captureRouteError", () => ({
  captureRouteError: mocks.captureRouteError,
}));

const ID = "11111111-1111-4111-8111-111111111111";
const context = { params: Promise.resolve({ id: ID }) };

function currentStatusQuery(status: string) {
  const query: Record<string, unknown> = {};
  query.select = vi.fn(() => query);
  query.eq = vi.fn(() => query);
  query.maybeSingle = vi.fn(async () => ({ data: { status }, error: null }));
  return query;
}

function request(status: string) {
  return new NextRequest(`http://axis.test/api/agent-tasks/${ID}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
}

describe("PATCH /api/agent-tasks/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUser.mockResolvedValue({
      data: { user: { id: "user_1" } },
      error: null,
    });
    mocks.from.mockReturnValue(currentStatusQuery("queued"));
    mocks.rpc.mockResolvedValue({
      data: {
        id: ID,
        objective: "Research",
        status: "gathering_data",
        context: {},
        created_at: "2026-07-16T00:00:00.000Z",
        updated_at: "2026-07-16T00:01:00.000Z",
        completed_at: null,
      },
      error: null,
    });
  });

  it("atomically claims the expected state and activity write through the RPC", async () => {
    const response = await PATCH(request("gathering_data"), context);

    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith("transition_agent_task", {
      p_task_id: ID,
      p_expected_status: "queued",
      p_next_status: "gathering_data",
    });
  });

  it("returns 409 when another transition wins the compare-and-set", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: null });

    const response = await PATCH(request("gathering_data"), context);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "STALE_TRANSITION",
      from: "queued",
      to: "gathering_data",
    });
    expect(mocks.captureRouteError).not.toHaveBeenCalled();
  });

  it("surfaces and captures an atomic transition/activity failure", async () => {
    const error = new Error("transaction failed");
    mocks.rpc.mockResolvedValue({ data: null, error });

    const response = await PATCH(request("gathering_data"), context);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "TASK_UPDATE_FAILED" });
    expect(mocks.captureRouteError).toHaveBeenCalledWith(
      error,
      expect.objectContaining({
        operation: "transition",
        code: "TASK_UPDATE_FAILED",
      }),
    );
  });
});
