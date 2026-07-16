import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { DELETE, PATCH } from "./route";

const mocks = vi.hoisted(() => ({ getUser: vi.fn(), from: vi.fn(), result: { data: null as unknown, error: null as unknown } }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: { getUser: mocks.getUser }, from: mocks.from }) }));
vi.mock("@/lib/observability/captureRouteError", () => ({ captureRouteError: vi.fn() }));

const ID = "11111111-1111-4111-8111-111111111111";
const context = { params: Promise.resolve({ id: ID }) };

function query() {
  const value: Record<string, unknown> = {};
  value.update = vi.fn(() => value);
  value.eq = vi.fn(() => value);
  value.select = vi.fn(() => value);
  value.maybeSingle = vi.fn(async () => mocks.result);
  return value as { update: ReturnType<typeof vi.fn>; eq: ReturnType<typeof vi.fn> };
}

describe("/api/memory/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUser.mockResolvedValue({ data: { user: { id: "user_1" } }, error: null });
    mocks.result = { data: { id: ID, status: "active" }, error: null };
  });

  it("rejects invalid ids before database access", async () => {
    const response = await DELETE(new NextRequest("http://axis.test/api/memory/nope", { method: "DELETE" }), { params: Promise.resolve({ id: "nope" }) });
    expect(response.status).toBe(400);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("updates only the authenticated owner's row", async () => {
    const q = query(); mocks.from.mockReturnValue(q);
    const response = await PATCH(new NextRequest(`http://axis.test/api/memory/${ID}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "Updated context" }) }), context);
    expect(response.status).toBe(200);
    expect(q.eq).toHaveBeenCalledWith("id", ID);
    expect(q.eq).toHaveBeenCalledWith("user_id", "user_1");
  });

  it("archives rather than silently deleting history", async () => {
    const q = query(); mocks.from.mockReturnValue(q);
    await DELETE(new NextRequest(`http://axis.test/api/memory/${ID}`, { method: "DELETE" }), context);
    expect(q.update).toHaveBeenCalledWith(expect.objectContaining({ status: "archived", archived_at: expect.any(String) }));
    expect(q.eq).toHaveBeenCalledWith("user_id", "user_1");
  });
});
