import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { DELETE } from "./route";

const deleteTokens = vi.fn();
const getUser = vi.fn();

vi.mock("@/lib/calendar/tokens", () => ({
  deleteTokens: (...args: unknown[]) => deleteTokens(...args),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser } }),
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
}));

function request(params = "provider=google") {
  return new NextRequest(`http://axis.test/api/calendar/disconnect?${params}`, { method: "DELETE" });
}

describe("DELETE /api/calendar/disconnect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUser.mockResolvedValue({ data: { user: { id: "user_1" } } });
  });

  it("returns success when the direct token row is deleted", async () => {
    deleteTokens.mockResolvedValueOnce(null);

    const res = await DELETE(request());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(deleteTokens).toHaveBeenCalledWith("user_1", "google");
  });

  it("returns non-OK when the direct token delete fails", async () => {
    deleteTokens.mockResolvedValueOnce({ message: "db unavailable" });

    const res = await DELETE(request());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({ error: "Could not disconnect calendar" });
  });

  it("rejects unsupported providers", async () => {
    const res = await DELETE(request("provider=icloud"));

    expect(res.status).toBe(400);
    expect(deleteTokens).not.toHaveBeenCalled();
  });
});
