import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issueMfaTrustToken, MFA_TRUST_COOKIE } from "@/lib/auth/mfaTrust";

const mocks = vi.hoisted(() => ({
  createServerClient: vi.fn(),
  getUser: vi.fn(),
  getAuthenticatorAssuranceLevel: vi.fn(),
  captureRouteError: vi.fn(),
}));

vi.mock("@supabase/ssr/dist/module/createServerClient", () => ({
  createServerClient: mocks.createServerClient,
}));

vi.mock("@/lib/observability/captureRouteError", () => ({
  captureRouteError: mocks.captureRouteError,
}));

import { middleware } from "./middleware";

const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const originalKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const originalTrustSecret = process.env.MFA_TRUST_SECRET;

function request(pathname: string, cookies?: Record<string, string>) {
  const headers = new Headers();
  if (cookies) headers.set("cookie", Object.entries(cookies).map(([key, value]) => `${key}=${value}`).join("; "));
  return new NextRequest(`https://axis.test${pathname}`, { headers });
}

function setEnv(name: "NEXT_PUBLIC_SUPABASE_URL" | "NEXT_PUBLIC_SUPABASE_ANON_KEY", value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function nextResponse(response: Response) {
  expect(response.status).toBe(200);
  expect(response.headers.get("x-middleware-next")).toBe("1");
}

describe("middleware access policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
    delete process.env.MFA_TRUST_SECRET;
    mocks.createServerClient.mockImplementation(() => ({
      auth: {
        getUser: mocks.getUser,
        mfa: { getAuthenticatorAssuranceLevel: mocks.getAuthenticatorAssuranceLevel },
      },
    }));
    mocks.getUser.mockResolvedValue({ data: { user: { id: "user_1" } }, error: null });
    mocks.getAuthenticatorAssuranceLevel.mockResolvedValue({
      data: { currentLevel: "aal1", nextLevel: "aal1" },
      error: null,
    });
  });

  afterEach(() => {
    if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = originalKey;
    if (originalTrustSecret === undefined) delete process.env.MFA_TRUST_SECRET;
    else process.env.MFA_TRUST_SECRET = originalTrustSecret;
  });

  it.each([
    ["NEXT_PUBLIC_SUPABASE_URL", undefined],
    ["NEXT_PUBLIC_SUPABASE_URL", "   "],
    ["NEXT_PUBLIC_SUPABASE_URL", "ftp://project.supabase.co"],
    ["NEXT_PUBLIC_SUPABASE_ANON_KEY", ""],
  ])("returns one observable 503 when %s is unavailable", async (name, value) => {
    setEnv(name as "NEXT_PUBLIC_SUPABASE_URL" | "NEXT_PUBLIC_SUPABASE_ANON_KEY", value);
    const response = await middleware(request("/api/future"));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: "AUTH_CONFIGURATION_UNAVAILABLE" });
    expect(mocks.captureRouteError).toHaveBeenCalledTimes(1);
  });

  it("fails closed for public auth-aware pages and client construction failures", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    expect((await middleware(request("/login"))).status).toBe(503);
    expect(mocks.captureRouteError).toHaveBeenCalledTimes(1);

    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    mocks.createServerClient.mockImplementationOnce(() => {
      throw new Error("client construction failed");
    });
    expect((await middleware(request("/api/future"))).status).toBe(503);
    expect(mocks.captureRouteError).toHaveBeenCalledTimes(2);
  });

  it("keeps only the exact public assets reachable when auth configuration is unavailable", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    for (const pathname of ["/terms", "/manifest.json", "/icon-512.png", "/sw.js", "/vector-assets/runtime.wasm"]) {
      nextResponse(await middleware(request(pathname)));
    }
    expect((await middleware(request("/art/cover.svg"))).status).toBe(503);
    expect((await middleware(request("/icon-512.png/extra"))).status).toBe(503);
    expect(mocks.getUser).not.toHaveBeenCalled();
  });

  it("fails closed for backend failures, but recognizes only exact cookie-less session absence", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: { name: "AuthSessionMissingError", status: 400 } });
    nextResponse(await middleware(request("/api/auth/forgot-password")));
    expect((await middleware(request("/api/future"))).status).toBe(401);

    mocks.getUser.mockResolvedValue({ data: { user: null }, error: { name: "AuthSessionMissingError", status: 400 } });
    expect((await middleware(request("/api/future", { "sb-project-auth-token": "present" }))).status).toBe(503);

    mocks.getUser.mockRejectedValue(new Error("network down"));
    expect((await middleware(request("/api/future"))).status).toBe(503);
    expect(mocks.captureRouteError).toHaveBeenCalledTimes(2);
  });

  it("does not redirect the trailing-slash login canonical form into a loop", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
    nextResponse(await middleware(request("/login/")));
  });

  it("defaults unknown, lookalike, and dotted application paths to authenticated", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
    for (const pathname of [
      "/api/future",
      "/api",
      "/api/auth/forgot-password/extra",
      "/api/cron/daily/extra",
      "/api/auth/profile-evil",
      "/api/mail/message/opaque.jpg",
    ]) {
      expect((await middleware(request(pathname))).status).toBe(401);
    }
    const protectedPage = await middleware(request("/fund/position/AAPL.png"));
    expect(protectedPage.status).toBe(307);
    expect(new URL(protectedPage.headers.get("location")!).pathname).toBe("/login");
  });

  it("bypasses Supabase only for exact self-authenticated service endpoints", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    for (const pathname of [
      "/api/plaid/webhook",
      "/api/webhooks/make",
      "/api/cron/daily",
      "/api/cron/feed-digest",
      "/api/cron/finance-daily",
      "/api/cron/intelligence-sweep",
    ]) nextResponse(await middleware(request(pathname)));
    expect(mocks.getUser).not.toHaveBeenCalled();
  });

  it("allows only the exact Sentry telemetry ingress during an auth outage", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    nextResponse(await middleware(request("/monitoring")));
    nextResponse(await middleware(request("/monitoring/")));
    expect((await middleware(request("/monitoring/extra"))).status).toBe(503);
    expect(mocks.getUser).not.toHaveBeenCalled();
  });

  it("preserves Supabase cookie mutations on denial and unavailable responses", async () => {
    mocks.createServerClient.mockImplementation((_url, _key, options) => {
      options.cookies.setAll([{ name: "sb-project-auth-token", value: "rotated", options: { path: "/" } }]);
      return {
        auth: {
          getUser: mocks.getUser,
          mfa: { getAuthenticatorAssuranceLevel: mocks.getAuthenticatorAssuranceLevel },
        },
      };
    });
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: { code: "unexpected" } });
    const unavailableResponse = await middleware(request("/api/future"));
    expect(unavailableResponse.status).toBe(503);
    expect(unavailableResponse.headers.get("set-cookie")).toContain("sb-project-auth-token=rotated");

    mocks.getUser.mockResolvedValue({ data: { user: null }, error: { code: "invalid_refresh_token" } });
    const deniedResponse = await middleware(request("/api/future", { "sb-project-auth-token": "old" }));
    expect(deniedResponse.status).toBe(401);
    expect(deniedResponse.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("carries rotated Supabase cookies on MFA denial and login redirects", async () => {
    mocks.createServerClient.mockImplementation((_url, _key, options) => {
      options.cookies.setAll([{ name: "sb-project-auth-token", value: "rotated", options: { path: "/" } }]);
      return {
        auth: {
          getUser: mocks.getUser,
          mfa: { getAuthenticatorAssuranceLevel: mocks.getAuthenticatorAssuranceLevel },
        },
      };
    });
    mocks.getAuthenticatorAssuranceLevel.mockResolvedValue({
      data: { currentLevel: "aal1", nextLevel: "aal2" },
      error: null,
    });
    const mfaDeniedResponse = await middleware(request("/api/future"));
    expect(mfaDeniedResponse.status).toBe(403);
    expect(mfaDeniedResponse.headers.get("set-cookie")).toContain("sb-project-auth-token=rotated");

    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
    const redirectResponse = await middleware(request("/command"));
    expect(redirectResponse.status).toBe(307);
    expect(redirectResponse.headers.get("set-cookie")).toContain("sb-project-auth-token=rotated");
  });

  it("preserves remembered-device MFA and bootstrap routes without login loops", async () => {
    process.env.MFA_TRUST_SECRET = "test-secret";
    mocks.getAuthenticatorAssuranceLevel.mockResolvedValue({
      data: { currentLevel: "aal1", nextLevel: "aal2" },
      error: null,
    });
    const issued = await issueMfaTrustToken({
      secret: "test-secret",
      userId: "user_1",
      factorId: "factor_1",
      nowMs: Date.now(),
      windowDays: 1,
    });
    expect(issued).not.toBeNull();
    nextResponse(await middleware(request("/api/future", { [MFA_TRUST_COOKIE]: issued!.token })));
    expect((await middleware(request("/api/future"))).status).toBe(403);
    for (const pathname of ["/api/auth/mfa/challenge", "/api/auth/mfa/verify", "/api/auth/mfa/trust-device"]) {
      nextResponse(await middleware(request(pathname)));
    }
    nextResponse(await middleware(request("/login?mfa=required")));
  });
});
