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

import { config, middleware } from "./middleware";

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
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://twkcvyhmlguipchfetge.supabase.co";
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

    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://twkcvyhmlguipchfetge.supabase.co";
    mocks.createServerClient.mockImplementationOnce(() => {
      throw new Error("client construction failed");
    });
    expect((await middleware(request("/api/future"))).status).toBe(503);
    expect(mocks.captureRouteError).toHaveBeenCalledTimes(2);
  });

  it("keeps only the exact public assets reachable when auth configuration is unavailable", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    for (const pathname of [
      "/terms",
      "/favicon.ico",
      "/manifest.json",
      "/icon-512.png",
      "/sw.js",
      "/vector-assets/runtime.wasm",
      "/_next/image",
      "/_next/static/chunks/app.js",
    ]) {
      nextResponse(await middleware(request(pathname)));
    }
    for (const pathname of [
      "/art/cover.svg",
      "/favicon.icoevil",
      "/icon-512.png/extra",
      "/_next/image-evil",
      "/_next/static-evil/chunk.js",
    ]) {
      expect((await middleware(request(pathname))).status).toBe(503);
    }
    expect(config.matcher).toEqual(["/:path*"]);
    expect(mocks.getUser).not.toHaveBeenCalled();
  });

  it("clears exact missing-session cookies without treating stale sessions as backend outages", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: { name: "AuthSessionMissingError", status: 400 } });
    nextResponse(await middleware(request("/api/auth/forgot-password")));
    expect((await middleware(request("/api/future"))).status).toBe(401);

    mocks.getUser.mockResolvedValue({ data: { user: null }, error: { name: "AuthSessionMissingError", status: 400 } });
    const stalePublicResponse = await middleware(
      request("/api/auth/forgot-password", { "sb-project-auth-token": "present" }),
    );
    nextResponse(stalePublicResponse);
    expect(stalePublicResponse.headers.get("set-cookie")).toContain("Max-Age=0");
    const staleProtectedResponse = await middleware(
      request("/api/future", { "sb-project-auth-token": "present" }),
    );
    expect(staleProtectedResponse.status).toBe(401);
    expect(staleProtectedResponse.headers.get("set-cookie")).toContain("Max-Age=0");

    mocks.getUser.mockRejectedValue(new Error("network down"));
    expect((await middleware(request("/api/future"))).status).toBe(503);
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: { name: "AuthSessionMissingError", status: 500 } });
    expect((await middleware(request("/api/future"))).status).toBe(503);
    expect(mocks.captureRouteError).toHaveBeenCalledTimes(2);
  });

  it("redirects browser assurance outages to login while APIs retain structured 503s", async () => {
    mocks.getAuthenticatorAssuranceLevel.mockResolvedValue({ data: null, error: new Error("unavailable") });

    const pageResponse = await middleware(request("/command?view=week"));
    expect(pageResponse.status).toBe(307);
    const location = new URL(pageResponse.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("authError")).toBe("assurance_unavailable");
    expect(location.searchParams.get("redirect")).toBe("/command?view=week");

    const apiResponse = await middleware(request("/api/future"));
    expect(apiResponse.status).toBe(503);
    await expect(apiResponse.json()).resolves.toMatchObject({ error: "AUTH_ASSURANCE_UNAVAILABLE" });

    nextResponse(await middleware(request("/login")));
    expect(mocks.captureRouteError).toHaveBeenCalledTimes(3);
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

  it("terminates signed-out Spotify callbacks at the public feedback handshake", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
    const response = await middleware(request("/api/spotify/callback?code=opaque&state=opaque"));
    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/oauth-done");
    expect(Object.fromEntries(location.searchParams)).toEqual({
      provider: "spotify",
      status: "error",
      reason: "session_expired",
    });

    mocks.getUser.mockResolvedValue({
      data: { user: null },
      error: { name: "AuthSessionMissingError", status: 400 },
    });
    const staleResponse = await middleware(
      request("/api/spotify/callback?code=opaque&state=opaque", { "sb-project-auth-token": "stale" }),
    );
    expect(staleResponse.status).toBe(307);
    expect(staleResponse.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("terminates every Spotify callback auth-boundary failure with safe public feedback", async () => {
    const feedbackReason = (response: Response) => {
      expect(response.status).toBe(307);
      const location = new URL(response.headers.get("location")!);
      expect(location.pathname).toBe("/oauth-done");
      expect(location.searchParams.has("code")).toBe(false);
      expect(location.searchParams.has("state")).toBe(false);
      return location.searchParams.get("reason");
    };

    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    expect(feedbackReason(await middleware(request("/api/spotify/callback?code=opaque&state=opaque"))))
      .toBe("auth_unavailable");

    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://twkcvyhmlguipchfetge.supabase.co";
    mocks.getUser.mockRejectedValueOnce(new Error("network down"));
    expect(feedbackReason(await middleware(request("/api/spotify/callback?code=opaque&state=opaque"))))
      .toBe("auth_unavailable");

    mocks.getAuthenticatorAssuranceLevel.mockResolvedValueOnce({ data: null, error: new Error("unavailable") });
    expect(feedbackReason(await middleware(request("/api/spotify/callback?code=opaque&state=opaque"))))
      .toBe("assurance_unavailable");

    mocks.getAuthenticatorAssuranceLevel.mockResolvedValueOnce({
      data: { currentLevel: "aal1", nextLevel: "aal2" },
      error: null,
    });
    expect(feedbackReason(await middleware(request("/api/spotify/callback?code=opaque&state=opaque"))))
      .toBe("mfa_required");

    expect(mocks.captureRouteError).toHaveBeenCalledTimes(3);
  });

  it("keeps Spotify callback descendants and lookalikes on ordinary default-deny responses", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
    for (const pathname of [
      "/api/spotify/callback/extra?code=opaque&state=opaque",
      "/api/spotify/callback-evil?code=opaque&state=opaque",
    ]) {
      const response = await middleware(request(pathname));
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toMatchObject({ error: "UNAUTHORIZED" });
      expect(response.headers.get("location")).toBeNull();
    }
  });

  it("refreshes existing root sessions without making the landing page auth-dependent", async () => {
    mocks.createServerClient.mockImplementation((_url, _key, options) => {
      options.cookies.setAll([{ name: "sb-project-auth-token", value: "rotated", options: { path: "/" } }]);
      return {
        auth: {
          getUser: mocks.getUser,
          mfa: { getAuthenticatorAssuranceLevel: mocks.getAuthenticatorAssuranceLevel },
        },
      };
    });
    const refreshed = await middleware(request("/", { "sb-project-auth-token": "expired" }));
    nextResponse(refreshed);
    expect(refreshed.headers.get("set-cookie")).toContain("sb-project-auth-token=rotated");
    expect(mocks.getUser).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    nextResponse(await middleware(request("/")));
    expect(mocks.createServerClient).not.toHaveBeenCalled();

    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    nextResponse(await middleware(request("/", { "sb-project-auth-token": "expired" })));
    expect(mocks.createServerClient).not.toHaveBeenCalled();
    expect(mocks.captureRouteError).not.toHaveBeenCalled();
  });

  it("keeps root public while preserving stale-cookie cleanup and refresh output", async () => {
    mocks.getUser.mockResolvedValueOnce({
      data: { user: null },
      error: { code: "invalid_refresh_token" },
    });
    const stale = await middleware(request("/", { "sb-project-auth-token": "stale" }));
    nextResponse(stale);
    expect(stale.headers.get("set-cookie")).toContain("Max-Age=0");

    mocks.createServerClient.mockImplementation((_url, _key, options) => {
      options.cookies.setAll([{ name: "sb-project-auth-token", value: "rotated", options: { path: "/" } }]);
      return {
        auth: {
          getUser: mocks.getUser,
          mfa: { getAuthenticatorAssuranceLevel: mocks.getAuthenticatorAssuranceLevel },
        },
      };
    });
    mocks.getUser.mockResolvedValueOnce({ data: { user: null }, error: { code: "unexpected" } });
    const backendFailure = await middleware(request("/", { "sb-project-auth-token": "expired" }));
    nextResponse(backendFailure);
    expect(backendFailure.headers.get("set-cookie")).toContain("sb-project-auth-token=rotated");
    // HomePage owns observation for this optional public probe; middleware
    // neither turns the landing page into a 503 nor double-reports the failure.
    expect(mocks.captureRouteError).not.toHaveBeenCalled();
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
    expect((await middleware(request("/monitoring-lookalike"))).status).toBe(503);
    expect(mocks.getUser).not.toHaveBeenCalled();

    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://twkcvyhmlguipchfetge.supabase.co";
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
    const descendantResponse = await middleware(request("/monitoring/extra"));
    const lookalikeResponse = await middleware(request("/monitoring-lookalike"));
    expect(descendantResponse.status).toBe(307);
    expect(lookalikeResponse.status).toBe(307);
    expect(new URL(descendantResponse.headers.get("location")!).pathname).toBe("/login");
    expect(new URL(lookalikeResponse.headers.get("location")!).pathname).toBe("/login");
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
