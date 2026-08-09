import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ captureRouteError: vi.fn() }));

vi.mock("@/lib/observability/captureRouteError", () => ({
  captureRouteError: mocks.captureRouteError,
}));

import { describeDirectProviderConnectFailure } from "@/lib/auth/directProviderConnectFailure";
import {
  DirectProviderRefreshError,
  directProviderRefreshFailureResponse,
} from "@/lib/auth/directProviderRefresh.server";

describe("AUTH-006 review finding containment", () => {
  beforeEach(() => {
    mocks.captureRouteError.mockReset();
  });

  it.each([
    ["spotify", "denied", "Spotify authorization was declined."],
    ["strava", "popup_blocked", "Allow pop-ups for AXIS, then reconnect Strava."],
    ["spotify", "state_invalid", "The Spotify sign-in could not be verified. Try connecting again in a single window."],
    ["strava", "token_exchange_failed", "Strava rejected the sign-in. Verify the provider redirect URI and try again."],
  ] as const)("maps %s %s to actionable provider feedback", (provider, reason, expected) => {
    expect(describeDirectProviderConnectFailure(provider, reason)).toBe(expected);
  });

  it.each([
    [502, "PROVIDER_REFRESH_UNAVAILABLE"],
    [504, "PROVIDER_REFRESH_TIMEOUT"],
  ] as const)("returns a private structured %s refresh failure and safe telemetry", async (status, code) => {
    const error = new DirectProviderRefreshError({
      provider: "spotify",
      status,
      code,
    });
    const response = directProviderRefreshFailureResponse(
      error,
      "/api/spotify/playback",
    );

    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    await expect(response.json()).resolves.toEqual({
      error: "PROVIDER_REFRESH_UNAVAILABLE",
      code,
    });
    expect(mocks.captureRouteError).toHaveBeenCalledWith(
      error,
      expect.objectContaining({
        route: "/api/spotify/playback",
        provider: "spotify",
        transport: "direct",
        operation: "refresh_token",
        status,
        code,
      }),
    );
    expect(JSON.stringify(mocks.captureRouteError.mock.calls)).not.toMatch(
      /access_token|refresh_token_value|bearer/i,
    );
  });

  it("returns an expected private 409 without reporting it as a Sentry error", async () => {
    const response = directProviderRefreshFailureResponse(
      new DirectProviderRefreshError({
        provider: "strava",
        status: 409,
        code: "PROVIDER_REFRESH_IN_PROGRESS",
      }),
      "/api/strava",
    );

    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    await expect(response.json()).resolves.toEqual({
      error: "PROVIDER_REFRESH_UNAVAILABLE",
      code: "PROVIDER_REFRESH_IN_PROGRESS",
    });
    expect(mocks.captureRouteError).not.toHaveBeenCalled();
  });
});
