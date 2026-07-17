import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  createTask: vi.fn(),
  capture: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: mocks.getUser } }),
}));
vi.mock("@/lib/tasks/taskPersistence", () => ({
  createAgentTaskWithActivity: (...args: unknown[]) => mocks.createTask(...args),
}));
vi.mock("@/lib/observability/captureRouteError", () => ({
  captureRouteError: (...args: unknown[]) => mocks.capture(...args),
}));

import { POST } from "./route";

function request(body: unknown) {
  return new NextRequest("http://axis.test/api/agent-tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("agent task creation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUser.mockResolvedValue({ data: { user: { id: "user_1" } }, error: null });
  });

  it("creates the task and initial activity through one atomic mutation", async () => {
    mocks.createTask.mockResolvedValue({
      ok: true,
      task: { id: "task_1", objective: "Inspect drift", status: "queued" },
    });

    const response = await POST(request({ objective: "Inspect drift", context: { source: "user" } }));

    expect(response.status).toBe(201);
    expect(mocks.createTask).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user_1",
      objective: "Inspect drift",
      context: { source: "user" },
    }));
  });

  it("fails visibly without the service-only mutation boundary", async () => {
    mocks.createTask.mockResolvedValue({ ok: false, code: "SERVICE_UNAVAILABLE" });

    const response = await POST(request({ objective: "Inspect drift" }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "TASK_MUTATION_UNAVAILABLE" });
    expect(mocks.capture).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({
      status: 503,
      code: "TASK_MUTATION_UNAVAILABLE",
    }));
  });

  it("rejects malformed routine links before mutation", async () => {
    const response = await POST(request({
      objective: "Inspect drift",
      source_routine_id: "not-a-uuid",
    }));

    expect(response.status).toBe(400);
    expect(mocks.createTask).not.toHaveBeenCalled();
  });
});
