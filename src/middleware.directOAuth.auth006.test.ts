import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

function request(path: string, method = "GET") {
  return new NextRequest(`https://axis.test${path}`, { method });
}

describe("AUTH-006 direct OAuth middleware containment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://twkcvyhmlguipchfetge.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
    mocks.createServerClient.mockImplementation(() => ({
      auth: {
        getUser: mocks.getUser,
        mfa: { getAuthenticatorAssuranceLevel: mocks.getAuthenticatorAssuranceLevel },
      },
    }));
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
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
  });

  it("terminates only the exact signed-out Strava callback with private safe feedback", async () => {
    const response = await middleware(request(
      "/api/strava?action=callback&code=provider-secret&state=opaque-state",
    ));

    expect(response.status).toBe(307);
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/oauth-done");
    expect(Object.fromEntries(location.searchParams)).toEqual({
      provider: "strava",
      status: "error",
      reason: "session_expired",
    });
    expect(location.searchParams.has("code")).toBe(false);
    expect(location.searchParams.has("state")).toBe(false);
    expect(response.headers.get("set-cookie")).toContain("strava_oauth_state=");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("terminally clears Spotify pending state when the callback loses its session", async () => {
    const response = await middleware(request(
      "/api/spotify/callback?code=provider-secret&state=opaque-state",
    ));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("provider=spotify");
    expect(response.headers.get("set-cookie")).toContain("spotify_oauth_state=");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it.each([
    ["configuration outage", "spotify", "/api/spotify/callback?code=x&state=y"],
    ["configuration outage", "strava", "/api/strava?action=callback&code=x&state=y"],
  ])("clears %s pending state for the exact %s callback", async (_case, provider, path) => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    const response = await middleware(request(path));

    expect(response.status).toBe(307);
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(response.headers.get("location")).toContain("reason=auth_unavailable");
    expect(response.headers.get("set-cookie")).toContain(`${provider}_oauth_state=`);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it.each([
    ["assurance outage", null, { data: null, error: new Error("unavailable") }, "assurance_unavailable"],
    ["MFA requirement", { id: "user" }, { data: { currentLevel: "aal1", nextLevel: "aal2" }, error: null }, "mfa_required"],
  ])("clears callback state on %s", async (_case, user, assurance, reason) => {
    mocks.getUser.mockResolvedValue({ data: { user: user ?? { id: "user" } }, error: null });
    mocks.getAuthenticatorAssuranceLevel.mockResolvedValue(assurance);
    const response = await middleware(request("/api/spotify/callback?code=x&state=y"));

    expect(response.status).toBe(307);
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(response.headers.get("location")).toContain(`reason=${reason}`);
    expect(response.headers.get("set-cookie")).toContain("spotify_oauth_state=");
  });

  it("clears pending state when callback authentication backend lookup fails", async () => {
    mocks.getUser.mockResolvedValue({
      data: { user: null },
      error: { name: "AuthApiError", status: 503, code: "backend_unavailable" },
    });
    const response = await middleware(request("/api/strava?action=callback&code=x&state=y"));

    expect(response.status).toBe(307);
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(response.headers.get("location")).toContain("reason=auth_unavailable");
    expect(response.headers.get("set-cookie")).toContain("strava_oauth_state=");
  });

  it.each([
    ["/api/spotify/playback", 401, "signed-out"],
    ["/api/strava?action=status", 403, "mfa"],
    ["/api/widgets/training", 503, "configuration"],
  ])("marks middleware denial private for %s", async (path, status, condition) => {
    if (condition === "mfa") {
      mocks.getUser.mockResolvedValue({ data: { user: { id: "user" } }, error: null });
      mocks.getAuthenticatorAssuranceLevel.mockResolvedValue({
        data: { currentLevel: "aal1", nextLevel: "aal2" },
        error: null,
      });
    } else if (condition === "configuration") {
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    }
    const response = await middleware(request(path));
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
  });

  it.each([
    ["/api/strava?action=callback&action=callback", "GET"],
    ["/api/strava/extra?action=callback", "GET"],
    ["/api/strava-evil?action=callback", "GET"],
    ["/api/strava?action=callback", "POST"],
    ["/api/spotify/callback/extra?code=opaque&state=opaque", "GET"],
  ])("keeps callback lookalikes on the ordinary API denial path: %s %s", async (path, method) => {
    const response = await middleware(request(path, method));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: "UNAUTHORIZED" });
    expect(response.headers.get("location")).toBeNull();
  });
});
