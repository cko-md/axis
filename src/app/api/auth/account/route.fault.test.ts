import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  updateUser: vi.fn(),
  admit: vi.fn(),
  rotateEpoch: vi.fn(),
  passwordPwned: vi.fn(),
  capture: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: mocks.getUser,
      updateUser: mocks.updateUser,
    },
  }),
}));
vi.mock("@/lib/admission", () => ({
  ADMISSION_POLICIES: {
    mfaVerify: {
      name: "mfa-verify",
      limit: 5,
      window: "5 m",
      protected: true,
    },
  },
  admit: (...args: unknown[]) => mocks.admit(...args),
}));
vi.mock("@/lib/auth/securityState", () => ({
  rotateMfaTrustEpoch: (...args: unknown[]) => mocks.rotateEpoch(...args),
}));
vi.mock("@/lib/auth/passwordCheck", () => ({
  isPasswordPwned: (...args: unknown[]) => mocks.passwordPwned(...args),
  PWNED_PASSWORD_MESSAGE: "Password is compromised",
}));
vi.mock("@/lib/observability/captureRouteError", () => ({
  captureRouteError: (...args: unknown[]) => mocks.capture(...args),
}));

import { POST } from "./route";

const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function passwordRequest(password = "correct horse battery staple") {
  return new NextRequest("https://axis.test/api/auth/account", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "change_password", password }),
  });
}

describe("account security mutation fault boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUser.mockResolvedValue({
      data: { user: { id: USER_ID } },
      error: null,
    });
    mocks.admit.mockResolvedValue({ kind: "allowed" });
    mocks.rotateEpoch.mockResolvedValue(2);
    mocks.passwordPwned.mockResolvedValue(false);
    mocks.updateUser.mockResolvedValue({ error: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rotates remembered-device trust before mutating the password", async () => {
    const response = await POST(passwordRequest());

    expect(response.status).toBe(200);
    expect(mocks.rotateEpoch.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.updateUser.mock.invocationCallOrder[0],
    );
  });

  it("maps authentication backend failures to 503 rather than unauthenticated", async () => {
    mocks.getUser.mockResolvedValue({
      data: { user: null },
      error: { code: "AUTH_BACKEND_DOWN" },
    });

    const response = await POST(passwordRequest());

    expect(response.status).toBe(503);
    expect(mocks.admit).not.toHaveBeenCalled();
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });

  it("does not write raw provider authentication errors to console", async () => {
    const sensitiveProviderMessage =
      "provider payload email=user@example.test token=server-secret";
    mocks.updateUser.mockResolvedValue({
      error: { message: sensitiveProviderMessage },
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await POST(passwordRequest());

    expect(consoleError).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining(sensitiveProviderMessage),
    );
  });

  it("classifies an account provider backend failure as safe 503", async () => {
    const sensitiveProviderMessage =
      "provider payload email=user@example.test token=server-secret";
    mocks.updateUser.mockResolvedValue({
      error: { message: sensitiveProviderMessage, status: 500 },
    });

    const response = await POST(passwordRequest());
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(body).not.toContain(sensitiveProviderMessage);
  });

  it("classifies a retryable auth transport failure with status zero as safe 503", async () => {
    const sensitiveProviderMessage =
      "fetch failed for token=server-secret email=user@example.test";
    mocks.updateUser.mockResolvedValue({
      error: {
        name: "AuthRetryableFetchError",
        status: 0,
        code: undefined,
        message: sensitiveProviderMessage,
      },
    });

    const response = await POST(passwordRequest());
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(body).not.toContain(sensitiveProviderMessage);
  });

  it("rejects an oversized account body before password checks or security mutation", async () => {
    const response = await POST(new NextRequest(
      "https://axis.test/api/auth/account",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "change_password",
          password: "correct horse battery staple",
          padding: "x".repeat(70_000),
        }),
      },
    ));

    expect(response.status).toBe(413);
    expect(mocks.passwordPwned).not.toHaveBeenCalled();
    expect(mocks.rotateEpoch).not.toHaveBeenCalled();
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });
});
