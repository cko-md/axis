import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const NOTE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TASK_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const mocks = vi.hoisted(() => ({ getUser: vi.fn(), resolve: vi.fn(), rpc: vi.fn() }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: mocks.getUser }, rpc: mocks.rpc }),
}));
vi.mock("@/lib/entities/server", () => ({ resolveEntity: mocks.resolve }));
vi.mock("@/lib/observability/captureRouteError", () => ({ captureRouteError: vi.fn() }));

import { POST } from "./route";

function request(body: unknown) {
  return new NextRequest("http://axis.test/api/entity-references", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/entity-references", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUser.mockResolvedValue({ data: { user: { id: "user_1" } }, error: null });
    mocks.resolve.mockResolvedValue({ ok: true, entity: {} });
    mocks.rpc.mockResolvedValue({ data: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", error: null });
  });

  it("rejects authority-like and malformed fields before auth or writes", async () => {
    const response = await POST(request({
      source: { kind: "note", id: NOTE_ID },
      target: { kind: "task", id: TASK_ID },
      canExecute: true,
    }));
    expect(response.status).toBe(400);
    expect(mocks.getUser).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("returns indistinguishable not-found when either endpoint is foreign", async () => {
    mocks.resolve
      .mockResolvedValueOnce({ ok: true, entity: {} })
      .mockResolvedValueOnce({ ok: false, error: { code: "NOT_FOUND", kind: "task" } });
    const response = await POST(request({
      source: { kind: "note", id: NOTE_ID },
      target: { kind: "task", id: TASK_ID },
    }));
    expect(response.status).toBe(404);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("persists a validated owner-scoped edge via the constrained RPC", async () => {
    const response = await POST(request({
      source: { kind: "note", id: NOTE_ID },
      target: { kind: "task", id: TASK_ID },
      relation: "supports",
    }));
    expect(response.status).toBe(201);
    expect(mocks.rpc).toHaveBeenCalledWith("create_entity_reference", expect.objectContaining({
      p_source_kind: "note",
      p_target_kind: "task",
      p_relation: "supports",
    }));
  });
});
