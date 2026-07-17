import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  admin: vi.fn(),
  deletePasskey: vi.fn(),
  capture: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: mocks.getUser } }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => mocks.admin(),
}));
vi.mock("@/lib/security/passkeyMutations", () => ({
  deleteUserPasskey: (...args: unknown[]) => mocks.deletePasskey(...args),
}));
vi.mock("@/lib/observability/captureRouteError", () => ({
  captureRouteError: (...args: unknown[]) => mocks.capture(...args),
}));

import { DELETE } from "./route";

const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PASSKEY_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function request() {
  return new NextRequest("http://axis.test/api/auth/passkey/delete", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ passkeyId: PASSKEY_ID }),
  });
}

describe("passkey deletion route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUser.mockResolvedValue({
      data: { user: { id: USER_ID } },
      error: null,
    });
    mocks.admin.mockReturnValue({ rpc: vi.fn() });
  });

  it("delegates credential deletion and auth-settings state to one atomic RPC", async () => {
    mocks.deletePasskey.mockResolvedValue({ ok: true, hasPasskeys: false });

    const response = await DELETE(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      hasPasskeys: false,
    });
    expect(mocks.deletePasskey).toHaveBeenCalledWith({
      userId: USER_ID,
      passkeyId: PASSKEY_ID,
    }, expect.anything());
  });

  it("keeps expected not-found deletion out of Sentry", async () => {
    mocks.deletePasskey.mockResolvedValue({ ok: false, code: "NOT_FOUND" });

    const response = await DELETE(request());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "PASSKEY_NOT_FOUND",
    });
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("rejects malformed IDs before calling the database or Sentry", async () => {
    const malformed = new NextRequest("http://axis.test/api/auth/passkey/delete", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ passkeyId: "not-a-uuid" }),
    });

    const response = await DELETE(malformed);

    expect(response.status).toBe(400);
    expect(mocks.deletePasskey).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
  });
});
