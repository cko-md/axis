import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ captureRouteError: vi.fn() }));

vi.mock("@/lib/observability/captureRouteError", () => ({
  captureRouteError: mocks.captureRouteError,
}));

import { describeDirectProviderConnectFailure } from "@/lib/auth/directProviderConnectFailure";
import {
  DirectProviderRefreshError,
  directProviderRefreshFailureResponse,
  setDirectProviderRefreshCoordinatorForTests,
  withDirectProviderRefreshLease,
} from "@/lib/auth/directProviderRefresh.server";

function fakeCoordinator(options: {
  failConsumedSet?: boolean;
  failRelease?: boolean;
} = {}) {
  const values = new Map<string, string>();
  const keys: string[] = [];
  let setCalls = 0;
  return {
    keys,
    async exists(key: string) {
      keys.push(key);
      return values.has(key) ? 1 : 0;
    },
    async set(
      key: string,
      value: string,
      config: { nx?: true; px?: number; ex?: number },
    ) {
      keys.push(key);
      setCalls += 1;
      if (options.failConsumedSet && setCalls === 2) {
        throw new Error("synthetic consumed write failure");
      }
      if (config.nx && values.has(key)) return null;
      values.set(key, value);
      return "OK";
    },
    async eval(_script: string, evalKeys: string[], args: string[]) {
      keys.push(...evalKeys);
      if (options.failRelease) throw new Error("synthetic release failure");
      const [key] = evalKeys;
      if (key && values.get(key) === args[0]) values.delete(key);
      return 1;
    },
  };
}

describe("AUTH-006 review finding containment", () => {
  beforeEach(() => {
    mocks.captureRouteError.mockReset();
  });

  afterEach(() => {
    process.env.DIRECT_PROVIDER_COOKIE_SECRET =
      "axis-test-direct-provider-cookie-secret-v2";
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

  it("returns an expected private 409 with a safe non-error telemetry breadcrumb", async () => {
    const error = new DirectProviderRefreshError({
        provider: "strava",
        status: 409,
        code: "PROVIDER_REFRESH_IN_PROGRESS",
      });
    const response = directProviderRefreshFailureResponse(
      error,
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
    expect(mocks.captureRouteError).toHaveBeenCalledWith(
      error,
      expect.objectContaining({
        route: "/api/strava",
        provider: "strava",
        status: 409,
        code: "PROVIDER_REFRESH_IN_PROGRESS",
      }),
    );
  });

  it("uses one rotation-invariant production claim for overlapping key deployments", async () => {
    const coordinator = fakeCoordinator();
    setDirectProviderRefreshCoordinatorForTests(coordinator);
    const options = {
      provider: "strava" as const,
      subject: "profile-rotation-test",
      refreshToken: "high-entropy-provider-refresh-token",
      refreshGeneration: "authenticated-generation",
      providerState: "d".repeat(43),
    };
    let providerCalls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    process.env.DIRECT_PROVIDER_COOKIE_SECRET = "old-axis-key";
    const oldDeployment = withDirectProviderRefreshLease(options, async () => {
      providerCalls += 1;
      await gate;
      return "fresh-credential";
    });
    await Promise.resolve();
    process.env.DIRECT_PROVIDER_COOKIE_SECRET = "new-axis-key";
    await expect(withDirectProviderRefreshLease(options, async () => {
      providerCalls += 1;
      return "stale-overwrite";
    })).rejects.toMatchObject({ status: 409, code: "PROVIDER_REFRESH_IN_PROGRESS" });
    release();
    await expect(oldDeployment).resolves.toBe("fresh-credential");
    expect(providerCalls).toBe(1);
    expect(coordinator.keys.join(" ")).not.toContain(options.subject);
    expect(coordinator.keys.join(" ")).not.toContain(options.refreshToken);
  });

  it("fails before provider traffic when the durable consumed claim cannot be written", async () => {
    setDirectProviderRefreshCoordinatorForTests(fakeCoordinator({
      failConsumedSet: true,
    }));
    const operation = vi.fn(async () => "must-not-run");
    await expect(withDirectProviderRefreshLease({
      provider: "spotify",
      subject: "profile-consumed-failure",
      refreshToken: "refresh-secret",
      refreshGeneration: "signed-generation",
    }, operation)).rejects.toMatchObject({
      status: 503,
      code: "PROVIDER_REFRESH_COORDINATOR_UNAVAILABLE",
    });
    expect(operation).not.toHaveBeenCalled();
  });

  it("preserves a successful rotation when best-effort lease release fails", async () => {
    setDirectProviderRefreshCoordinatorForTests(fakeCoordinator({
      failRelease: true,
    }));
    await expect(withDirectProviderRefreshLease({
      provider: "strava",
      subject: "profile-release-failure",
      refreshToken: "rotating-refresh-secret",
      refreshGeneration: "signed-generation",
    }, async () => "fresh-rotated-credential")).resolves.toBe(
      "fresh-rotated-credential",
    );
    expect(mocks.captureRouteError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "PROVIDER_REFRESH_COORDINATOR_UNAVAILABLE" }),
      expect.objectContaining({
        route: "/internal/direct-provider-refresh",
        operation: "release_refresh_lease",
        status: 503,
      }),
    );
  });
});
