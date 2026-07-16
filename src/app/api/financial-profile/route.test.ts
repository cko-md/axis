import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, PUT } from "./route";

const mocks = vi.hoisted(() => ({ getUser: vi.fn(), from: vi.fn(), result: { data: null as unknown, error: null as unknown } }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: { getUser: mocks.getUser }, from: mocks.from }) }));
vi.mock("@/lib/observability/captureRouteError", () => ({ captureRouteError: vi.fn() }));

function query() {
  const value: Record<string, unknown> = {};
  value.select = vi.fn(() => value);
  value.eq = vi.fn(() => value);
  value.maybeSingle = vi.fn(async () => mocks.result);
  value.upsert = vi.fn(() => value);
  value.single = vi.fn(async () => mocks.result);
  return value as { eq: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn> };
}

const profile = {
  base_currency: "USD",
  risk_posture: "balanced",
  investment_horizon: "long_term",
  liquidity_buffer_months: 6,
  concentration_limit_bps: 2000,
  priorities: ["Resilience"],
  constraints: ["No leverage"],
};

describe("/api/financial-profile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUser.mockResolvedValue({ data: { user: { id: "user_1" } }, error: null });
    mocks.result = { data: { user_id: "user_1", ...profile }, error: null };
  });

  it("loads only the authenticated owner's profile", async () => {
    const q = query(); mocks.from.mockReturnValue(q);
    expect((await GET()).status).toBe(200);
    expect(q.eq).toHaveBeenCalledWith("user_id", "user_1");
  });

  it("rejects non-deterministic profile limits", async () => {
    const q = query(); mocks.from.mockReturnValue(q);
    const response = await PUT(new NextRequest("http://axis.test/api/financial-profile", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...profile, concentration_limit_bps: 12.5 }) }));
    expect(response.status).toBe(400);
    expect(q.upsert).not.toHaveBeenCalled();
  });

  it("confirms user provenance on owner-scoped upsert", async () => {
    const q = query(); mocks.from.mockReturnValue(q);
    const response = await PUT(new NextRequest("http://axis.test/api/financial-profile", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(profile) }));
    expect(response.status).toBe(200);
    expect(q.upsert).toHaveBeenCalledWith(expect.objectContaining({ user_id: "user_1", source_type: "user_asserted", confirmed_at: expect.any(String) }), { onConflict: "user_id" });
  });
});
