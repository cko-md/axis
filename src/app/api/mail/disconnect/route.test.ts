import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { DELETE } from "./route";

const deleteMailTokens = vi.fn();
const deleteMailCacheForAccount = vi.fn();
const getUser = vi.fn();

vi.mock("@/lib/mail/tokens", () => ({
  deleteMailTokens: (...args: unknown[]) => deleteMailTokens(...args),
}));
vi.mock("@/lib/mail/cache", () => ({
  deleteMailCacheForAccount: (...args: unknown[]) => deleteMailCacheForAccount(...args),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser } }),
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
}));

function request(params = "provider=gmail&email=user%40example.com") {
  return new NextRequest(`http://axis.test/api/mail/disconnect?${params}`, { method: "DELETE" });
}

describe("DELETE /api/mail/disconnect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUser.mockResolvedValue({ data: { user: { id: "user_1" } } });
  });

  it("returns success when the direct token row is deleted", async () => {
    deleteMailTokens.mockResolvedValueOnce(null);
    deleteMailCacheForAccount.mockResolvedValueOnce(undefined);

    const res = await DELETE(request());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(deleteMailTokens).toHaveBeenCalledWith("user_1", "gmail", "user@example.com");
    expect(deleteMailCacheForAccount).toHaveBeenCalledWith(
      expect.anything(), "user_1", { provider: "gmail", mailEmail: "user@example.com" },
    );
  });

  it("returns non-OK when the direct token delete fails", async () => {
    deleteMailTokens.mockResolvedValueOnce({ message: "db unavailable" });

    const res = await DELETE(request());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({ error: "Could not disconnect mailbox" });
  });

  it("requires an email", async () => {
    const res = await DELETE(request("provider=gmail"));

    expect(res.status).toBe(400);
    expect(deleteMailTokens).not.toHaveBeenCalled();
  });

  it("surfaces cache cleanup failure after provider disconnect", async () => {
    deleteMailTokens.mockResolvedValueOnce(null);
    deleteMailCacheForAccount.mockRejectedValueOnce(new Error("cache unavailable"));

    const res = await DELETE(request());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toMatch(/saved inbox cleanup failed/i);
  });
});
