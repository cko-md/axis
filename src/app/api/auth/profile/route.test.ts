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

  it("normalizes missing refresh sessions to signed out but captures genuine auth failures", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: { code: "invalid_refresh_token", status: 401 } });
    expect((await GET()).status).toBe(401); expect(mocks.capture).not.toHaveBeenCalled();
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: { message: "auth service unavailable", status: 503 } });
    expect((await GET()).status).toBe(500); expect(mocks.capture).toHaveBeenCalled();
  });

  it("captures thrown identity reads without returning raw errors", async () => {
    mocks.getUser.mockRejectedValue(new Error("private auth transport detail"));
    const response = await GET(); expect(response.status).toBe(500); expect(await response.json()).toEqual({ error: "PROFILE_ACCOUNT_UNAVAILABLE" });
    expect(JSON.stringify(mocks.capture.mock.calls)).not.toContain("private auth transport detail");
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

  it("rejects null, arrays, malformed, extra, and oversized PATCH bodies without writing", async () => {
    const q = query(); mocks.from.mockReturnValue(q);
    for (const body of [null, [], {}, { name: "n", role: "r", bio: "b", photo: "p", extra: true }, { name: "x".repeat(2001), role: "r", bio: "b", photo: "p" }]) {
      expect((await PATCH(new NextRequest("http://axis.test/api/auth/profile", { method: "PATCH", body: JSON.stringify(body) }))).status).toBe(400);
    }
    expect(q.upsert).not.toHaveBeenCalled();
  });

  it("requires exact same-origin JSON and enforces actual body bytes before auth", async () => {
    for (const request of [
      new NextRequest("http://axis.test/api/auth/profile", { method: "PATCH", body: "{}" }),
      new NextRequest("http://axis.test/api/auth/profile", { method: "PATCH", headers: { "Content-Type": "application/json", Origin: "http://evil.test" }, body: "{}" }),
      new NextRequest("http://axis.test/api/auth/profile", { method: "PATCH", headers: { "Content-Type": "application/json", Origin: "http://axis.test" }, body: JSON.stringify({ name: "x".repeat(10001), role: "", bio: "", photo: "" }) }),
    ]) expect((await PATCH(request)).status).toBe(400);
  });
});
