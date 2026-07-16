import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST } from "./route";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  from: vi.fn(),
  result: { data: [] as unknown[], error: null as unknown },
  singleResult: { data: null as unknown, error: null as unknown },
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: mocks.getUser }, from: mocks.from }),
}));
vi.mock("@/lib/observability/captureRouteError", () => ({ captureRouteError: vi.fn() }));

function query() {
  const value: Record<string, unknown> = {};
  value.select = vi.fn(() => value);
  value.eq = vi.fn(() => value);
  value.order = vi.fn(() => value);
  value.insert = vi.fn(() => value);
  value.single = vi.fn(async () => mocks.singleResult);
  value.then = (resolve: (result: unknown) => void) => resolve(mocks.result);
  return value as {
    select: ReturnType<typeof vi.fn>;
    eq: ReturnType<typeof vi.fn>;
    order: ReturnType<typeof vi.fn>;
    insert: ReturnType<typeof vi.fn>;
    single: ReturnType<typeof vi.fn>;
  };
}

describe("/api/memory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUser.mockResolvedValue({ data: { user: { id: "user_1" } }, error: null });
    mocks.result = { data: [], error: null };
    mocks.singleResult = { data: { id: "memory_1" }, error: null };
  });

  it("rejects unauthenticated creation before database access", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
    const response = await POST(new NextRequest("http://axis.test/api/memory", { method: "POST", body: "{}" }));
    expect(response.status).toBe(401);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("lists only the authenticated owner's requested lifecycle", async () => {
    const q = query();
    mocks.from.mockReturnValue(q);
    const response = await GET(new NextRequest("http://axis.test/api/memory?status=archived"));
    expect(response.status).toBe(200);
    expect(q.eq).toHaveBeenCalledWith("user_id", "user_1");
    expect(q.eq).toHaveBeenCalledWith("status", "archived");
  });

  it("rejects authority-like and unbounded request fields", async () => {
    const q = query();
    mocks.from.mockReturnValue(q);
    const response = await POST(new NextRequest("http://axis.test/api/memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "context", scope: "global", content: "Remember", confidence_bps: 10000, expires_at: null, can_execute: true }),
    }));
    expect(response.status).toBe(400);
    expect(q.insert).not.toHaveBeenCalled();
  });

  it("pins user provenance and ownership on creation", async () => {
    const q = query();
    mocks.from.mockReturnValue(q);
    const response = await POST(new NextRequest("http://axis.test/api/memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "goal", scope: "financial", content: "Preserve optionality", confidence_bps: 9000, expires_at: null }),
    }));
    expect(response.status).toBe(201);
    expect(q.insert).toHaveBeenCalledWith(expect.objectContaining({ user_id: "user_1", source_type: "user_asserted", source_ref: null, status: "active" }));
  });
});
