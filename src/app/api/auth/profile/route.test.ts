import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ capture: vi.fn(), getUser: vi.fn(), from: vi.fn(), result: { data: null as unknown, error: null as unknown } }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: { getUser: mocks.getUser }, from: mocks.from }) }));
vi.mock("@/lib/observability/captureRouteError", () => ({ captureRouteError: mocks.capture }));

import { GET, PATCH } from "./route";

function query() {
  const value: Record<string, unknown> = {};
  value.select = vi.fn(() => value); value.eq = vi.fn(() => value); value.maybeSingle = vi.fn(async () => mocks.result);
  value.upsert = vi.fn(async () => ({ error: mocks.result.error }));
  return value;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUser.mockResolvedValue({ data: { user: { id: "owner", email: null } }, error: null });
  mocks.result = { data: { display_name: null, role_title: null, bio: null, avatar_url: null }, error: null };
});

describe("/api/auth/profile", () => {
  it("returns an explicit signed-out response", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
    expect((await GET()).status).toBe(401);
  });

  it("returns only the bounded profile shape and supports accounts without email", async () => {
    mocks.from.mockReturnValue(query());
    expect(await (await GET()).json()).toEqual({ display_name: null, role_title: null, bio: null, avatar_url: null, email: null });
  });

  it("maps database failures to a generic response and fixed observability metadata", async () => {
    mocks.from.mockReturnValue(query()); mocks.result = { data: null, error: { message: "private database detail" } };
    const response = await GET();
    expect(response.status).toBe(500); expect(await response.json()).toEqual({ error: "PROFILE_ACCOUNT_UNAVAILABLE" });
    expect(mocks.capture).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ route: "/api/auth/profile", code: "PROFILE_ACCOUNT_UNAVAILABLE" }));
    expect(JSON.stringify(mocks.capture.mock.calls)).not.toContain("private database detail");
  });

  it("rejects malformed, extra, and oversized PATCH bodies without writing", async () => {
    const q = query(); mocks.from.mockReturnValue(q);
    for (const body of [{}, { name: "n", role: "r", bio: "b", photo: "p", extra: true }, { name: "x".repeat(2001), role: "r", bio: "b", photo: "p" }]) {
      expect((await PATCH(new NextRequest("http://axis.test/api/auth/profile", { method: "PATCH", body: JSON.stringify(body) }))).status).toBe(400);
    }
    expect(q.upsert).not.toHaveBeenCalled();
  });
});
