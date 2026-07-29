import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  captureRouteError: vi.fn(),
  getUser: vi.fn(),
  listFactors: vi.fn(),
  maybeSingle: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock("@/lib/observability/captureRouteError", () => ({
  captureRouteError: mocks.captureRouteError,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: mocks.getUser,
      mfa: { listFactors: mocks.listFactors },
    },
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: mocks.maybeSingle }),
      }),
      upsert: mocks.upsert,
    }),
  }),
}));

import { GET, POST } from "./route";

const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function postRequest() {
  return new NextRequest("http://axis.test/api/auth/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ biometric_prompted: true }),
  });
}

describe("auth settings route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUser.mockResolvedValue({ data: { user: { id: USER_ID } } });
    mocks.maybeSingle.mockResolvedValue({ data: null, error: null });
    mocks.listFactors.mockResolvedValue({ data: { all: [] }, error: null });
    mocks.upsert.mockResolvedValue({ error: null });
  });

  it("returns defaults when a new user has no settings row", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      passkey_enabled: false,
      biometric_prompted: false,
      twofa_enabled: false,
      twofa_method: null,
      recovery_email: null,
      remember_me: false,
      mfa_factors: [],
    });
    expect(mocks.captureRouteError).not.toHaveBeenCalled();
  });

  it("fails closed and records safe metadata when the settings query fails", async () => {
    mocks.maybeSingle.mockResolvedValue({
      data: null,
      error: { code: "42501", message: "sensitive database detail" },
    });

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({ error: "AUTH_SETTINGS_UNAVAILABLE" });
    expect(JSON.stringify(body)).not.toContain("sensitive database detail");
    expect(mocks.captureRouteError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Auth settings operation failed" }),
      {
        route: "/api/auth/settings",
        operation: "read_settings",
        area: "auth",
        status: 500,
        code: "AUTH_SETTINGS_READ_FAILED",
      },
    );
  });

  it("fails closed and records safe metadata when listing MFA factors fails", async () => {
    mocks.listFactors.mockResolvedValue({
      data: { all: [] },
      error: { code: "unexpected", message: "sensitive factor detail" },
    });

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({ error: "AUTH_SETTINGS_UNAVAILABLE" });
    expect(JSON.stringify(body)).not.toContain("sensitive factor detail");
    expect(mocks.captureRouteError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Auth settings operation failed" }),
      {
        route: "/api/auth/settings",
        operation: "list_mfa_factors",
        area: "auth",
        status: 500,
        code: "MFA_FACTORS_READ_FAILED",
      },
    );
  });

  it("returns settings and a safe MFA factor projection on success", async () => {
    mocks.maybeSingle.mockResolvedValue({
      data: {
        passkey_enabled: true,
        biometric_prompted: true,
        twofa_enabled: true,
        twofa_method: "totp",
        recovery_email: "person@example.test",
        remember_me: true,
      },
      error: null,
    });
    mocks.listFactors.mockResolvedValue({
      data: { all: [{ id: "factor-1", factor_type: "totp", status: "verified", secret: "not-returned" }] },
      error: null,
    });

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      passkey_enabled: true,
      biometric_prompted: true,
      twofa_enabled: true,
      twofa_method: "totp",
      recovery_email: "person@example.test",
      remember_me: true,
      mfa_factors: [{ id: "factor-1", type: "totp", status: "verified" }],
    });
  });

  it("does not log or return a raw settings write error", async () => {
    mocks.upsert.mockResolvedValue({
      error: { code: "23505", message: "sensitive database detail" },
    });

    const response = await POST(postRequest());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({ error: "AUTH_SETTINGS_UNAVAILABLE" });
    expect(JSON.stringify(body)).not.toContain("sensitive database detail");
    expect(mocks.captureRouteError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Auth settings operation failed" }),
      {
        route: "/api/auth/settings",
        operation: "save_settings",
        area: "auth",
        status: 500,
        code: "AUTH_SETTINGS_SAVE_FAILED",
      },
    );
  });
});
