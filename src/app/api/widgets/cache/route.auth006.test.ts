import { beforeEach, describe, expect, it, vi } from "vitest";
import { EXPECTED_PROFILE_SUBJECT_HEADER } from "@/lib/auth/profileSubject";
import { profileSubjectForUserId } from "@/lib/auth/profileSubject.server";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  captureRouteError: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/observability/captureRouteError", () => ({
  captureRouteError: mocks.captureRouteError,
}));
vi.mock("@/lib/widgets/registry", () => ({
  getWidgetDefinition: (id: string) => id === "run" ? {
    id,
    label: "Run",
    statusDefault: "setup_required",
    source: {
      provider: "strava",
      endpoint: "/api/widgets/training",
      cacheKey: "training",
      requiresAuth: true,
      requiresLocation: false,
    },
    freshness: { staleAfterSeconds: 60 },
  } : undefined,
}));

import { POST } from "./route";

describe("AUTH-006 subject-bound widget cache", () => {
  const userId = "cache-user";
  const subject = profileSubjectForUserId(userId);
  const inQuery = vi.fn();
  const eqQuery = vi.fn(() => ({ in: inQuery }));
  const selectQuery = vi.fn(() => ({ eq: eqQuery }));

  beforeEach(() => {
    vi.clearAllMocks();
    inQuery.mockResolvedValue({
      data: [{
        widget_id: "run",
        cache_key: "training",
        status: "fresh",
        value: "5 km",
        hint: "Cached run",
        raw: {},
        error: null,
        fetched_at: "2026-08-09T00:00:00.000Z",
        expires_at: "2026-08-09T00:15:00.000Z",
      }, {
        widget_id: "unknown",
        cache_key: "obsolete",
        status: "fresh",
        value: "must not escape",
        hint: "obsolete",
        raw: {},
        error: null,
        fetched_at: "2026-08-09T00:00:00.000Z",
        expires_at: null,
      }],
      error: null,
    });
    mocks.createClient.mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: userId } },
          error: null,
        }),
      },
      from: vi.fn(() => ({ select: selectQuery })),
    });
  });

  function request(headers?: HeadersInit, widgetIds: string[] = ["run"]) {
    return new Request("https://axis.test/api/widgets/cache", {
      method: "POST",
      headers,
      body: JSON.stringify({ widgetIds }),
    });
  }

  it("rejects a stale-account request before reading cache rows", async () => {
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect(selectQuery).not.toHaveBeenCalled();
  });

  it("returns a private unauthorized response without reading cache rows", async () => {
    mocks.createClient.mockResolvedValueOnce({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: null },
          error: new Error("no session"),
        }),
      },
    });
    const response = await POST(request({
      [EXPECTED_PROFILE_SUBJECT_HEADER]: subject,
    }));
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(selectQuery).not.toHaveBeenCalled();
  });

  it("reads only the authenticated user's current widget definitions", async () => {
    const response = await POST(request({
      [EXPECTED_PROFILE_SUBJECT_HEADER]: subject,
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(eqQuery).toHaveBeenCalledWith("user_id", userId);
    expect(inQuery).toHaveBeenCalledWith("widget_id", ["run"]);
    expect(await response.json()).toEqual({
      rows: [expect.objectContaining({ widget_id: "run", value: "5 km" })],
    });
  });

  it("bounds request ids before any database read", async () => {
    const response = await POST(request(
      { [EXPECTED_PROFILE_SUBJECT_HEADER]: subject },
      Array.from({ length: 25 }, (_, index) => `widget-${index}`),
    ));
    expect(response.status).toBe(400);
    expect(selectQuery).not.toHaveBeenCalled();
  });

  it("captures a safe cache-read failure and returns no rows", async () => {
    inQuery.mockResolvedValueOnce({
      data: null,
      error: { code: "CACHE_READ_FAILED", message: "private database detail" },
    });
    const response = await POST(request({
      [EXPECTED_PROFILE_SUBJECT_HEADER]: subject,
    }));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "WIDGET_CACHE_UNAVAILABLE" });
    expect(mocks.captureRouteError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        route: "/api/widgets/cache",
        operation: "read_cache",
        provider: "supabase",
        code: "CACHE_READ_FAILED",
      }),
    );
  });
});
