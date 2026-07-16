import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  getAuthenticatorAssuranceLevel: vi.fn(),
}));

vi.mock("@supabase/ssr/dist/module/createServerClient", () => ({
  createServerClient: vi.fn(() => ({
    auth: {
      getUser: mocks.getUser,
      mfa: {
        getAuthenticatorAssuranceLevel: mocks.getAuthenticatorAssuranceLevel,
      },
    },
  })),
}));

vi.mock("@/lib/observability/captureRouteError", () => ({
  captureRouteError: vi.fn(),
}));

import { middleware } from "./middleware";

describe("middleware authenticator assurance", () => {
  const ORIGINAL_APP_URL = process.env.NEXT_PUBLIC_APP_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.NEXT_PUBLIC_APP_URL;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
    mocks.getUser.mockResolvedValue({
      data: { user: { id: "user_1" } },
      error: null,
    });
  });

  afterEach(() => {
    if (ORIGINAL_APP_URL === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = ORIGINAL_APP_URL;
  });

  it("blocks direct protected API use while an enrolled MFA factor is pending", async () => {
    mocks.getAuthenticatorAssuranceLevel.mockResolvedValue({
      data: { currentLevel: "aal1", nextLevel: "aal2" },
      error: null,
    });

    const response = await middleware(
      new NextRequest("https://axis.test/api/approvals"),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: "MFA_REQUIRED",
    });
  });

  it("allows only the MFA challenge and verify bootstrap routes at aal1", async () => {
    mocks.getAuthenticatorAssuranceLevel.mockResolvedValue({
      data: { currentLevel: "aal1", nextLevel: "aal2" },
      error: null,
    });

    const verifyResponse = await middleware(
      new NextRequest("https://axis.test/api/auth/mfa/verify"),
    );
    const unenrollResponse = await middleware(
      new NextRequest("https://axis.test/api/auth/mfa/unenroll"),
    );

    expect(verifyResponse.status).toBe(200);
    expect(verifyResponse.headers.get("x-middleware-next")).toBe("1");
    expect(unenrollResponse.status).toBe(403);
  });

  it("redirects protected pages to the login MFA ceremony without looping login", async () => {
    mocks.getAuthenticatorAssuranceLevel.mockResolvedValue({
      data: { currentLevel: "aal1", nextLevel: "aal2" },
      error: null,
    });

    const protectedResponse = await middleware(
      new NextRequest("https://axis.test/approvals?filter=pending"),
    );
    const loginResponse = await middleware(
      new NextRequest("https://axis.test/login?mfa=required"),
    );

    expect(protectedResponse.status).toBe(307);
    const location = new URL(protectedResponse.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("mfa")).toBe("required");
    expect(location.searchParams.get("redirect")).toBe(
      "/approvals?filter=pending",
    );
    expect(loginResponse.status).toBe(200);
    expect(loginResponse.headers.get("x-middleware-next")).toBe("1");
  });

  it("allows protected APIs after the session reaches aal2", async () => {
    mocks.getAuthenticatorAssuranceLevel.mockResolvedValue({
      data: { currentLevel: "aal2", nextLevel: "aal2" },
      error: null,
    });

    const response = await middleware(
      new NextRequest("https://axis.test/api/approvals"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("keeps unauthenticated preview redirects on the preview origin", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://axis.example.com";
    mocks.getUser.mockResolvedValue({
      data: { user: null },
      error: null,
    });

    const response = await middleware(
      new NextRequest("https://axis-preview.vercel.app/command"),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://axis-preview.vercel.app/login?redirect=%2Fcommand",
    );
  });

  it("keeps unauthenticated loopback redirects on the raw request host", async () => {
    mocks.getUser.mockResolvedValue({
      data: { user: null },
      error: null,
    });

    const response = await middleware(
      new NextRequest("http://localhost:3200/command", {
        headers: { host: "127.0.0.1:3200" },
      }),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "http://127.0.0.1:3200/login?redirect=%2Fcommand",
    );
  });
});
