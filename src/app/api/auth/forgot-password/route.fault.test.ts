import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  admit: vi.fn(),
  resetPasswordForEmail: vi.fn(),
}));

vi.mock("@/lib/admission", () => ({
  ADMISSION_POLICIES: {
    mfaChallenge: {
      name: "mfa-challenge",
      limit: 10,
      window: "5 m",
      protected: true,
    },
  },
  admit: (...args: unknown[]) => mocks.admit(...args),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { resetPasswordForEmail: mocks.resetPasswordForEmail },
  }),
}));
vi.mock("@/lib/auth/getAppOrigin", () => ({
  getAppOrigin: () => "https://axis.test",
}));

import { POST } from "./route";

function request(forwardedFor: string) {
  return new NextRequest("https://axis.test/api/auth/forgot-password", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": forwardedFor,
      "x-real-ip": forwardedFor,
    },
    body: JSON.stringify({ email: "User@Example.test" }),
  });
}

describe("forgot-password fault boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.admit.mockResolvedValue({ kind: "allowed" });
    mocks.resetPasswordForEmail.mockResolvedValue({
      data: {},
      error: null,
    });
  });

  it("does not let spoofed forwarded headers change quota identity", async () => {
    await POST(request("198.51.100.1"));
    await POST(request("203.0.113.99"));

    expect(mocks.admit).toHaveBeenCalledTimes(2);
    expect(mocks.admit.mock.calls[0]).toEqual(mocks.admit.mock.calls[1]);
    expect(mocks.admit).toHaveBeenCalledWith(
      "password-reset:user@example.test",
      expect.objectContaining({
        name: "forgot-password",
        globalGuard: {
          name: "forgot-password-global",
          subject: "password-reset-global",
          limit: 300,
          window: "15 m",
        },
      }),
    );
  });

  it("fails closed before provider work when hosted admission is unavailable", async () => {
    mocks.admit.mockResolvedValue({
      kind: "unavailable",
      reason: "backend",
    });

    const response = await POST(request("198.51.100.1"));

    expect(response.status).toBe(503);
    expect(mocks.resetPasswordForEmail).not.toHaveBeenCalled();
  });

  it("does not claim a reset was sent when the auth backend failed", async () => {
    mocks.resetPasswordForEmail.mockResolvedValue({
      data: null,
      error: { code: "AUTH_BACKEND_DOWN" },
    });

    const response = await POST(request("198.51.100.1"));

    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("AUTH_BACKEND_DOWN");
  });

  it("keeps quota exhaustion enumeration-opaque and avoids provider work", async () => {
    mocks.admit.mockResolvedValue({
      kind: "limited",
      retryAfterSeconds: 60,
    });

    const response = await POST(request("198.51.100.1"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      message: "If an account exists, a reset link has been sent.",
    });
    expect(mocks.resetPasswordForEmail).not.toHaveBeenCalled();
  });

  it("rejects an oversized reset body before quota or provider work", async () => {
    const response = await POST(new NextRequest(
      "https://axis.test/api/auth/forgot-password",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "user@example.test",
          padding: "x".repeat(70_000),
        }),
      },
    ));

    expect(response.status).toBe(413);
    expect(mocks.admit).not.toHaveBeenCalled();
    expect(mocks.resetPasswordForEmail).not.toHaveBeenCalled();
  });
});
