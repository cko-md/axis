import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const NOTE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const mocks = vi.hoisted(() => ({ getUser: vi.fn(), resolve: vi.fn(), rpc: vi.fn() }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: mocks.getUser }, rpc: mocks.rpc }),
}));
vi.mock("@/lib/entities/server", () => ({ resolveEntity: mocks.resolve }));
vi.mock("@/lib/observability/captureRouteError", () => ({ captureRouteError: vi.fn() }));

import { POST } from "./route";

describe("POST /api/entities/[kind]/[id]/usage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUser.mockResolvedValue({ data: { user: { id: "user_1" } }, error: null });
    mocks.resolve.mockResolvedValue({ ok: true, entity: { ref: { kind: "note", id: NOTE_ID } } });
    mocks.rpc.mockResolvedValue({ data: {}, error: null });
  });

  it("rejects preview usage before database access", async () => {
    const response = await POST(
      new NextRequest("http://axis.test/api/entities/note/x", { method: "POST", body: JSON.stringify({ action: "preview" }) }),
      { params: Promise.resolve({ kind: "note", id: NOTE_ID }) },
    );
    expect(response.status).toBe(400);
    expect(mocks.getUser).not.toHaveBeenCalled();
  });

  it("does not record usage for a missing or foreign-owned entity", async () => {
    mocks.resolve.mockResolvedValue({ ok: false, error: { code: "NOT_FOUND", kind: "note" } });
    const response = await POST(
      new NextRequest("http://axis.test/api/entities/note/x", { method: "POST", body: JSON.stringify({ action: "search" }) }),
      { params: Promise.resolve({ kind: "note", id: NOTE_ID }) },
    );
    expect(response.status).toBe(404);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("records one explicit activation through the atomic RPC", async () => {
    const response = await POST(
      new NextRequest("http://axis.test/api/entities/note/x", { method: "POST", body: JSON.stringify({ action: "search" }) }),
      { params: Promise.resolve({ kind: "note", id: NOTE_ID }) },
    );
    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith("record_entity_usage", {
      p_entity_kind: "note",
      p_entity_id: NOTE_ID,
      p_action: "search",
    });
  });
});
