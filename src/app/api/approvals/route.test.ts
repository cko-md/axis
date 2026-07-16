import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  sessionFrom: vi.fn(),
  adminFrom: vi.fn(),
  createAdminClient: vi.fn(),
  captureRouteError: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: mocks.getUser },
    from: mocks.sessionFrom,
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: mocks.createAdminClient,
}));
vi.mock("@/lib/observability/captureRouteError", () => ({
  captureRouteError: mocks.captureRouteError,
}));

const TASK_ID = "11111111-1111-4111-8111-111111111111";

function body(taskId: string = TASK_ID) {
  return {
    actor: { kind: "agent", id: "envoy_1" },
    tool: "tasks.update",
    summary: "Update the linked task",
    context: { actionClass: "INTERNAL_WRITE" },
    target: { entityType: "agent_task", entityId: taskId },
    taskId,
  };
}

function request(payload = body()) {
  return new NextRequest("http://axis.test/api/approvals", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function readQuery(result: { data: unknown; error: unknown }) {
  const value: Record<string, unknown> = {};
  value.select = vi.fn(() => value);
  value.eq = vi.fn(() => value);
  value.maybeSingle = vi.fn(async () => result);
  return value;
}

function insertQuery(result: { data: unknown; error: unknown }) {
  const value: Record<string, unknown> = {};
  value.insert = vi.fn(() => value);
  value.select = vi.fn(() => value);
  value.single = vi.fn(async () => result);
  return value as { insert: ReturnType<typeof vi.fn> };
}

describe("POST /api/approvals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUser.mockResolvedValue({
      data: { user: { id: "user_1" } },
      error: null,
    });
  });

  it("rejects a task link that is not owned by the authenticated user", async () => {
    mocks.sessionFrom.mockReturnValue(readQuery({ data: null, error: null }));

    const response = await POST(request());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "TASK_NOT_FOUND" });
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
  });

  it("validates task ownership with the session, then writes through the admin client", async () => {
    const ownedTask = readQuery({ data: { id: TASK_ID }, error: null });
    const inserted = insertQuery({
      data: {
        id: "22222222-2222-4222-8222-222222222222",
        status: "pending",
      },
      error: null,
    });
    mocks.sessionFrom.mockReturnValue(ownedTask);
    mocks.createAdminClient.mockReturnValue({ from: mocks.adminFrom });
    mocks.adminFrom.mockReturnValue(inserted);

    const response = await POST(request());

    expect(response.status).toBe(201);
    expect(mocks.sessionFrom).toHaveBeenCalledWith("agent_tasks");
    expect(mocks.adminFrom).toHaveBeenCalledWith("approvals");
    expect(inserted.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: "user_1",
        task_id: TASK_ID,
      }),
    );
  });

  it("returns a visible 503 instead of falling back to a browser client", async () => {
    mocks.sessionFrom.mockReturnValue(readQuery({ data: { id: TASK_ID }, error: null }));
    mocks.createAdminClient.mockReturnValue(null);

    const response = await POST(request());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "APPROVAL_WRITE_UNAVAILABLE",
      message: "Approval writes are temporarily unavailable.",
    });
    expect(mocks.adminFrom).not.toHaveBeenCalled();
  });
});
