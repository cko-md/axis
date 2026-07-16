import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  from: vi.fn(),
  transition: vi.fn(),
  capture: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: mocks.getUser }, from: mocks.from }),
}));
vi.mock("@/lib/tasks/taskPersistence", () => ({
  transitionAgentTask: (...args: unknown[]) => mocks.transition(...args),
}));
vi.mock("@/lib/observability/captureRouteError", () => ({
  captureRouteError: (...args: unknown[]) => mocks.capture(...args),
}));

import { GET, PATCH } from "./route";

const TASK_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TASK = {
  id: TASK_ID,
  objective: "Review concentration",
  status: "queued",
  context: {},
  source_routine_id: null,
  source_skill: null,
  estimated_cost_usd: null,
  actual_cost_usd: null,
  created_at: "2026-07-16T00:00:00.000Z",
  updated_at: "2026-07-16T00:00:00.000Z",
  completed_at: null,
};

function taskQuery(result: { data: unknown; error: unknown }) {
  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  query.select = vi.fn(() => query);
  query.eq = vi.fn(() => query);
  query.maybeSingle = vi.fn(async () => result);
  return query;
}

function activityQuery(result: { data: unknown; error: unknown }) {
  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  query.select = vi.fn(() => query);
  query.eq = vi.fn(() => query);
  query.order = vi.fn(async () => result);
  return query;
}

function patch(status: string) {
  return new NextRequest(`http://axis.test/api/agent-tasks/${TASK_ID}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
}

describe("agent task detail lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUser.mockResolvedValue({ data: { user: { id: "user_1" } }, error: null });
  });

  it("surfaces activity query failure instead of returning a false empty audit log", async () => {
    mocks.from.mockImplementation((table: string) => table === "agent_tasks"
      ? taskQuery({ data: TASK, error: null })
      : activityQuery({ data: null, error: { code: "DB_DOWN" } }));

    const response = await GET(
      new NextRequest(`http://axis.test/api/agent-tasks/${TASK_ID}`),
      { params: Promise.resolve({ id: TASK_ID }) },
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "TASK_ACTIVITY_UNAVAILABLE" });
    expect(mocks.capture).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({
      code: "TASK_ACTIVITY_UNAVAILABLE",
      operation: "detail_activity",
    }));
  });

  it("maps a lost CAS race to a retryable stale-state conflict", async () => {
    mocks.from.mockReturnValue(taskQuery({ data: { status: "queued" }, error: null }));
    mocks.transition.mockResolvedValue({
      ok: false,
      code: "CONFLICT",
      currentStatus: "cancelled",
    });

    const response = await PATCH(
      patch("gathering_data"),
      { params: Promise.resolve({ id: TASK_ID }) },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "STALE_TRANSITION",
      from: "queued",
      to: "gathering_data",
      currentStatus: "cancelled",
    });
    expect(mocks.transition).toHaveBeenCalledOnce();
  });

  it("returns the task committed by the atomic transition", async () => {
    mocks.from.mockReturnValue(taskQuery({ data: { status: "queued" }, error: null }));
    mocks.transition.mockResolvedValue({
      ok: true,
      task: { ...TASK, status: "gathering_data" },
    });

    const response = await PATCH(
      patch("gathering_data"),
      { params: Promise.resolve({ id: TASK_ID }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      task: { ...TASK, status: "gathering_data" },
    });
    expect(mocks.transition).toHaveBeenCalledWith(expect.objectContaining({
      taskId: TASK_ID,
      expectedStatus: "queued",
      nextStatus: "gathering_data",
    }));
  });
});
