import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { EXPECTED_PROFILE_SUBJECT_HEADER } from "@/lib/auth/profileSubject";
import { profileSubjectForUserId } from "@/lib/auth/profileSubject.server";
import { createOAuthPendingState } from "@/lib/auth/oauthState.server";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  getAccessToken: vi.fn(),
  getComposioConnection: vi.fn(),
  getComposioAthlete: vi.fn(),
  listComposioActivities: vi.fn(),
  cookieStore: {
    values: new Map<string, string>(),
    operations: [] as string[],
    get: vi.fn((name: string) => {
      const value = mocks.cookieStore.values.get(name);
      return value === undefined ? undefined : { name, value };
    }),
    set: vi.fn((name: string, value: string) => {
      mocks.cookieStore.operations.push(`set:${name}`);
      mocks.cookieStore.values.set(name, value);
    }),
    delete: vi.fn((name: string) => {
      mocks.cookieStore.operations.push(`delete:${name}`);
      mocks.cookieStore.values.delete(name);
    }),
  },
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => mocks.cookieStore) }));
vi.mock("@/lib/observability/captureRouteError", () => ({ captureRouteError: vi.fn() }));
vi.mock("@/lib/integrations/strava-composio", () => ({
  getComposioStravaConnection: mocks.getComposioConnection,
  getComposioStravaAthlete: mocks.getComposioAthlete,
  listComposioStravaActivities: mocks.listComposioActivities,
}));
vi.mock("./_lib", () => ({
  isConfigured: () => true,
  getAccessToken: mocks.getAccessToken,
  stravaGet: vi.fn(),
  notConnected: () => new Response(JSON.stringify({ connected: false }), { status: 401 }),
}));

import { GET, POST } from "./route";

function authenticatedAs(userId: string) {
  mocks.createClient.mockResolvedValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: { id: userId } },
        error: null,
      }),
    },
  });
}

describe("AUTH-006 Strava server identity boundary", () => {
  const userA = "strava-user-a";
  const userB = "strava-user-b";
  const subjectA = profileSubjectForUserId(userA);
  const secret = "strava-test-secret";

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cookieStore.values.clear();
    mocks.cookieStore.operations.length = 0;
    mocks.getComposioConnection.mockResolvedValue(null);
    process.env.STRAVA_CLIENT_ID = "strava-client";
    process.env.STRAVA_CLIENT_SECRET = secret;
    delete process.env.NEXT_PUBLIC_APP_URL;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.STRAVA_CLIENT_ID;
    delete process.env.STRAVA_CLIENT_SECRET;
  });

  it("allows only subject-bound POST initiation and leaves legacy GET fail closed", async () => {
    authenticatedAs(userA);
    const legacy = await GET(new NextRequest("https://axis.test/api/strava?action=auth", {
      headers: { [EXPECTED_PROFILE_SUBJECT_HEADER]: subjectA },
    }));
    expect(legacy.status).toBe(405);
    expect(mocks.cookieStore.set).not.toHaveBeenCalled();

    const missingSubject = await POST(new NextRequest("https://axis.test/api/strava?action=auth", {
      method: "POST",
    }));
    expect(missingSubject.status).toBe(409);

    const started = await POST(new NextRequest("https://axis.test/api/strava?action=auth", {
      method: "POST",
      headers: { [EXPECTED_PROFILE_SUBJECT_HEADER]: subjectA },
    }));
    const body = await started.json() as { url: string };
    const providerUrl = new URL(body.url);
    expect(providerUrl.origin).toBe("https://www.strava.com");
    expect(providerUrl.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(started.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(mocks.cookieStore.values.get("strava_oauth_state")).toContain(".");
    expect(body.url).not.toContain(subjectA);
  });

  it("consumes state and blocks provider exchange when the session subject changed", async () => {
    const nonce = "n".repeat(43);
    const { providerState, sealedState } = createOAuthPendingState({
      provider: "strava",
      subject: subjectA,
      secret,
      nonce,
    });
    mocks.cookieStore.values.set("strava_oauth_state", sealedState);
    authenticatedAs(userB);
    const providerFetch = vi.fn();
    vi.stubGlobal("fetch", providerFetch);

    const response = await GET(new NextRequest(
      `https://axis.test/api/strava?action=callback&code=secret-code&state=${providerState}`,
    ));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("reason=state_invalid");
    expect(response.headers.get("location")).not.toContain("secret-code");
    expect(mocks.cookieStore.operations[0]).toBe("delete:strava_oauth_state");
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("makes direct disconnect a subject-bound POST and rejects duplicate callback actions", async () => {
    authenticatedAs(userA);
    mocks.cookieStore.values.set("strava_token_owner", subjectA);
    mocks.cookieStore.values.set("strava_access_token", "access");
    mocks.cookieStore.values.set("strava_refresh_token", "refresh");
    mocks.cookieStore.values.set("strava_oauth_state", "sealed-pending-state");

    const legacyDisconnect = await GET(new NextRequest(
      "https://axis.test/api/strava?action=disconnect",
      { headers: { [EXPECTED_PROFILE_SUBJECT_HEADER]: subjectA } },
    ));
    expect(legacyDisconnect.status).toBe(405);
    expect(mocks.cookieStore.values.get("strava_access_token")).toBe("access");

    const disconnected = await POST(new NextRequest(
      "https://axis.test/api/strava?action=disconnect",
      {
        method: "POST",
        headers: { [EXPECTED_PROFILE_SUBJECT_HEADER]: subjectA },
      },
    ));
    expect(disconnected.status).toBe(200);
    expect(mocks.cookieStore.values.has("strava_token_owner")).toBe(false);
    expect(mocks.cookieStore.values.has("strava_access_token")).toBe(false);
    expect(mocks.cookieStore.values.has("strava_refresh_token")).toBe(false);
    expect(mocks.cookieStore.values.has("strava_oauth_state")).toBe(false);

    const providerFetch = vi.fn();
    vi.stubGlobal("fetch", providerFetch);
    const duplicateCallback = await GET(new NextRequest(
      "https://axis.test/api/strava?action=callback&action=callback&code=secret&state=secret",
      { headers: { [EXPECTED_PROFILE_SUBJECT_HEADER]: subjectA } },
    ));
    expect(duplicateCallback.status).toBe(400);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("consumes pending state before route-level authentication failure", async () => {
    mocks.cookieStore.values.set("strava_oauth_state", "sealed-pending-state");
    mocks.createClient.mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: null }),
      },
    });
    const providerFetch = vi.fn();
    vi.stubGlobal("fetch", providerFetch);

    const response = await GET(new NextRequest(
      "https://axis.test/api/strava?action=callback&code=secret-code&state=opaque-state",
    ));

    expect(response.headers.get("location")).toContain("reason=session_expired");
    expect(mocks.cookieStore.operations[0]).toBe("delete:strava_oauth_state");
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("preserves Composio precedence before consulting direct cookies", async () => {
    authenticatedAs(userA);
    mocks.getComposioConnection.mockResolvedValue({ connectedAccountId: "connection" });
    mocks.getComposioAthlete.mockResolvedValue({
      firstname: "Test",
      lastname: "Athlete",
      profile: "https://images.test/avatar",
    });

    const response = await GET(new NextRequest("https://axis.test/api/strava?action=status", {
      headers: { [EXPECTED_PROFILE_SUBJECT_HEADER]: subjectA },
    }));
    const body = await response.json();

    expect(body).toMatchObject({ connected: true, configured: true, via: "composio" });
    expect(mocks.getAccessToken).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
  });
});
