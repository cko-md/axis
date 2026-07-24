import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  aal: vi.fn(),
  listFactors: vi.fn(),
  securityState: vi.fn(),
  cookieOptions: null as null | {
    cookies: {
      setAll: (cookies: Array<{
        name: string;
        value: string;
        options?: Record<string, unknown>;
      }>) => void;
    };
  },
}));
vi.mock("@supabase/ssr/dist/module/createServerClient", () => ({
  createServerClient: vi.fn((
    _url: string,
    _key: string,
    options: typeof mocks.cookieOptions,
  ) => {
    mocks.cookieOptions = options;
    return {
      auth: {
        getUser: mocks.getUser,
        mfa: {
          getAuthenticatorAssuranceLevel: mocks.aal,
          listFactors: mocks.listFactors,
        },
      },
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: mocks.securityState,
          }),
        }),
      }),
    };
  }),
}));
vi.mock("@/lib/observability/captureRouteError", () => ({ captureRouteError: vi.fn() }));

import { middleware } from "./middleware";

describe("middleware default-deny access policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cookieOptions = null;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
    delete process.env.MFA_TRUST_SECRET;
    mocks.getUser.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
    mocks.aal.mockResolvedValue({ data: { currentLevel: "aal1", nextLevel: "aal2" }, error: null });
    mocks.listFactors.mockResolvedValue({
      data: {
        all: [{ id: "current-factor", status: "verified" }],
      },
      error: null,
    });
    mocks.securityState.mockResolvedValue({
      data: { mfa_trust_epoch: 1 },
      error: null,
    });
  });

  it("does not bypass MFA for widgets or gallery", async () => {
    expect((await middleware(new NextRequest("https://axis.test/api/widgets/agenda"))).status).toBe(403);
    expect((await middleware(new NextRequest("https://axis.test/api/gallery"))).status).toBe(403);
  });

  it("returns 503 for absent configuration and auth backend failure", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    expect((await middleware(new NextRequest("https://axis.test/api/future"))).status).toBe(503);
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: { code: "network_error" } });
    expect((await middleware(new NextRequest("https://axis.test/command"))).status).toBe(503);
  });

  it("rejects a non-HTTP local Supabase URL as a safe configuration failure", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "ftp://127.0.0.1";

    const response = await middleware(
      new NextRequest("https://axis.test/command"),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "AUTH_CONFIGURATION_UNAVAILABLE",
    });
    expect(mocks.getUser).not.toHaveBeenCalled();
  });

  it("returns 401 for a future signed-out API route", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
    expect((await middleware(new NextRequest("https://axis.test/api/future"))).status).toBe(401);
  });

  it.each([
    ["/fund/position/AAPL.png", 307],
    ["/api/mail/message/opaque.jpg", 401],
  ])("does not infer public access from an image-looking protected path: %s", async (pathname, status) => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });

    const response = await middleware(
      new NextRequest(`https://axis.test${pathname}`),
    );

    expect(response.status).toBe(status);
    expect(response.headers.get("x-middleware-next")).not.toBe("1");
  });

  it.each([
    "/api/auth/forgot-password",
    "/api/auth/passkey/authenticate",
  ])("allows the exact keyless flow only after proving the session absent: %s", async (pathname) => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });

    const response = await middleware(new NextRequest(`https://axis.test${pathname}`));

    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it.each([
    "/login",
    "/auth/callback",
    "/api/auth/forgot-password",
    "/api/auth/passkey/authenticate",
  ])("treats Supabase's exact cookie-less missing-session error as proven absence: %s", async (pathname) => {
    mocks.getUser.mockResolvedValue({
      data: { user: null },
      error: {
        name: "AuthSessionMissingError",
        status: 400,
        code: undefined,
      },
    });

    const response = await middleware(
      new NextRequest(`https://axis.test${pathname}`),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("does not accept a missing-session error as absence when an auth cookie exists", async () => {
    mocks.getUser.mockResolvedValue({
      data: { user: null },
      error: {
        name: "AuthSessionMissingError",
        status: 400,
        code: undefined,
      },
    });

    const response = await middleware(
      new NextRequest("https://axis.test/api/auth/forgot-password", {
        headers: { cookie: "sb-axis-auth-token=present" },
      }),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "AUTH_BACKEND_UNAVAILABLE",
    });
  });

  it.each([
    "/api/auth/forgot-password",
    "/api/auth/passkey/authenticate",
  ])("fails a keyless flow closed when auth cannot establish absence: %s", async (pathname) => {
    mocks.getUser.mockResolvedValue({
      data: { user: null },
      error: { code: "network_error" },
    });

    const response = await middleware(new NextRequest(`https://axis.test${pathname}`));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "AUTH_BACKEND_UNAVAILABLE",
    });
  });

  it.each([
    "/api/auth/forgot-password",
    "/api/auth/passkey/authenticate",
  ])("fails a keyless flow closed when auth configuration is absent: %s", async (pathname) => {
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    const response = await middleware(new NextRequest(`https://axis.test${pathname}`));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "AUTH_CONFIGURATION_UNAVAILABLE",
    });
    expect(mocks.getUser).not.toHaveBeenCalled();
  });

  it("carries broken-auth cookie deletion onto a default-deny API response", async () => {
    mocks.getUser.mockImplementation(async () => {
      mocks.cookieOptions?.cookies.setAll([{
        name: "sb-axis-auth-token",
        value: "",
        options: { maxAge: 0, path: "/" },
      }]);
      return {
        data: { user: null },
        error: { code: "invalid_refresh_token" },
      };
    });
    const request = new NextRequest("https://axis.test/api/future", {
      headers: { cookie: "sb-axis-auth-token=broken" },
    });

    const response = await middleware(request);

    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toContain("sb-axis-auth-token=");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it.each([
    ["MFA-required API denial", "/api/approvals", "mfa_required"],
    ["MFA-required page redirect", "/approvals", "mfa_required"],
    ["satisfied login redirect", "/login", "satisfied"],
  ] as const)("carries refreshed auth cookies onto the %s response", async (_name, pathname, assurance) => {
    mocks.getUser.mockImplementation(async () => {
      mocks.cookieOptions?.cookies.setAll([{
        name: "sb-axis-auth-token",
        value: "rotated-token",
        options: { maxAge: 3600, path: "/" },
      }]);
      return {
        data: { user: { id: "user-1" } },
        error: null,
      };
    });
    mocks.aal.mockResolvedValue(
      assurance === "satisfied"
        ? { data: { currentLevel: "aal2", nextLevel: "aal2" }, error: null }
        : { data: { currentLevel: "aal1", nextLevel: "aal2" }, error: null },
    );

    const response = await middleware(
      new NextRequest(`https://axis.test${pathname}`),
    );

    const setCookie = response.headers.get("set-cookie");
    expect(setCookie).not.toBeNull();
    expect(setCookie ?? "").toContain(
      "sb-axis-auth-token=rotated-token",
    );
  });

  it.each(["/", "/terms", "/privacy", "/oauth-done"])(
    "keeps genuinely public static/legal pages available without auth infrastructure: %s",
    async (pathname) => {
      delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

      const response = await middleware(
        new NextRequest(`https://axis.test${pathname}`),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("x-middleware-next")).toBe("1");
      expect(mocks.getUser).not.toHaveBeenCalled();
    },
  );

  it.each([
    "/manifest.json",
    "/apple-touch-icon.png",
    "/icon-192.png",
    "/sw.js",
    "/vector-assets/second-sense/cover.svg",
  ])("allows only an explicitly audited public asset without auth infrastructure: %s", async (pathname) => {
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    const response = await middleware(
      new NextRequest(`https://axis.test${pathname}`),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(mocks.getUser).not.toHaveBeenCalled();
  });

  it.each([
    ["resolved factor error", () => mocks.listFactors.mockResolvedValue({
      data: null,
      error: { code: "AUTH_BACKEND_DOWN" },
    })],
    ["thrown factor error", () => mocks.listFactors.mockRejectedValue(
      new Error("sensitive provider failure"),
    )],
  ])("returns observable 503 for remembered-MFA %s", async (_case, failLookup) => {
    process.env.MFA_TRUST_SECRET = "test-mfa-secret";
    const { issueMfaTrustToken } = await import("@/lib/auth/mfaTrust");
    const issued = await issueMfaTrustToken({
      secret: process.env.MFA_TRUST_SECRET,
      userId: "user-1",
      factorId: "old-factor",
      trustEpoch: 1,
      nowMs: Date.now(),
      windowDays: 30,
    });
    failLookup();

    const response = await middleware(new NextRequest(
      "https://axis.test/api/future",
      {
        headers: {
          cookie: `axis_mfa_trust=${issued?.token}`,
        },
      },
    ));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "AUTH_BACKEND_UNAVAILABLE",
    });
  });

  it("does not bypass MFA after out-of-band factor replacement", async () => {
    process.env.MFA_TRUST_SECRET = "test-mfa-secret";
    const { issueMfaTrustToken } = await import("@/lib/auth/mfaTrust");
    const issued = await issueMfaTrustToken({
      secret: process.env.MFA_TRUST_SECRET,
      userId: "user-1",
      factorId: "old-factor",
      trustEpoch: 1,
      nowMs: Date.now(),
      windowDays: 30,
    });

    const response = await middleware(new NextRequest(
      "https://axis.test/api/future",
      {
        headers: {
          cookie: `axis_mfa_trust=${issued?.token}`,
        },
      },
    ));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: "MFA_REQUIRED",
    });
    expect(mocks.listFactors).toHaveBeenCalledOnce();
  });
});
