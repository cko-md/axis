import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { profileSubjectForUserId } from "@/lib/auth/profileSubject.server";
import { createOAuthPendingState } from "@/lib/auth/oauthState.server";
import {
  createProviderOwnerSeal,
  replaceProviderTokenCookiesForAttempt,
} from "@/lib/auth/providerCookies.server";
import { DirectProviderRefreshError } from "@/lib/auth/directProviderRefresh.server";

const mocks = vi.hoisted(() => ({
  cookieStore: {
    values: new Map<string, string>(),
    get: vi.fn((name: string) => {
      const value = mocks.cookieStore.values.get(name);
      return value === undefined ? undefined : { name, value };
    }),
    getAll: vi.fn(() => [...mocks.cookieStore.values].map(([name, value]) => ({
      name,
      value,
    }))),
    set: vi.fn((name: string, value: string) => mocks.cookieStore.values.set(name, value)),
    delete: vi.fn((name: string) => mocks.cookieStore.values.delete(name)),
  },
}));

vi.mock("next/headers", () => ({ cookies: vi.fn(async () => mocks.cookieStore) }));

import { getAccessToken as getSpotifyAccessToken } from "./spotify/_lib";
import { getAccessToken as getStravaAccessToken } from "./strava/_lib";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("AUTH-006 direct provider token helpers", () => {
  const userId = "provider-user";
  const subject = profileSubjectForUserId(userId);

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cookieStore.values.clear();
    process.env.SPOTIFY_CLIENT_ID = "spotify-client";
    process.env.SPOTIFY_CLIENT_SECRET = "spotify-secret";
    process.env.STRAVA_CLIENT_ID = "strava-client";
    process.env.STRAVA_CLIENT_SECRET = "strava-secret";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.SPOTIFY_CLIENT_ID;
    delete process.env.SPOTIFY_CLIENT_SECRET;
    delete process.env.STRAVA_CLIENT_ID;
    delete process.env.STRAVA_CLIENT_SECRET;
  });

  it.each([
    {
      provider: "spotify" as const,
      owner: "spotify_token_owner",
      access: "spotify_access_token",
      refresh: "spotify_refresh_token",
      invalidOwner: subject,
      getAccessToken: getSpotifyAccessToken,
    },
    {
      provider: "strava" as const,
      owner: "strava_token_owner",
      access: "strava_access_token",
      refresh: "strava_refresh_token",
      invalidOwner: createProviderOwnerSeal("spotify", subject, "strava-secret"),
      getAccessToken: getStravaAccessToken,
    },
  ])("rejects invalid $provider ownership before provider traffic without deleting another subject", async ({
    owner,
    access,
    refresh,
    invalidOwner,
    getAccessToken,
  }) => {
    mocks.cookieStore.values.set(owner, invalidOwner);
    mocks.cookieStore.values.set(access, "stale-access");
    mocks.cookieStore.values.set(refresh, "stale-refresh");
    const providerFetch = vi.fn();
    vi.stubGlobal("fetch", providerFetch);

    await expect(getAccessToken(userId)).resolves.toBeNull();

    expect(mocks.cookieStore.values.get(owner)).toBe(invalidOwner);
    expect(mocks.cookieStore.values.get(access)).toBe("stale-access");
    expect(mocks.cookieStore.values.get(refresh)).toBe("stale-refresh");
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("accepts a fixed Spotify owner seal only for the server-authenticated user id", async () => {
    mocks.cookieStore.values.set(
      "spotify_token_owner",
      createProviderOwnerSeal("spotify", subject, "spotify-secret"),
    );
    mocks.cookieStore.values.set("spotify_access_token", "bound-access");

    await expect(getSpotifyAccessToken(userId)).resolves.toBe("bound-access");
    await expect(getSpotifyAccessToken("different-user")).resolves.toBeNull();
    expect(mocks.cookieStore.values.get("spotify_access_token")).toBe("bound-access");
  });

  it.each([
    ["spotify", "SPOTIFY_CLIENT_SECRET", getSpotifyAccessToken],
    ["strava", "STRAVA_CLIENT_SECRET", getStravaAccessToken],
  ] as const)("returns disconnected when %s owner sealing is not configured", async (
    _provider,
    secretName,
    getAccessToken,
  ) => {
    delete process.env[secretName];
    await expect(getAccessToken(userId)).resolves.toBeNull();
  });

  it("refreshes an attempt credential without publishing into a shared slot", async () => {
    const providerState = "g".repeat(43);
    replaceProviderTokenCookiesForAttempt(
      mocks.cookieStore,
      "spotify",
      { accessToken: "expired-access", refreshToken: "attempt-refresh" },
      subject,
      "spotify-secret",
      { providerState, initiatedAtMs: Date.UTC(2026, 7, 8) },
    );
    mocks.cookieStore.values.delete(`spotify_access_token_a1_${providerState}`);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: "fresh-attempt-access",
      expires_in: 900,
    }), { status: 200 })));

    await expect(getSpotifyAccessToken(userId)).resolves.toBe(
      "fresh-attempt-access",
    );
    expect(mocks.cookieStore.values.get(
      `spotify_access_token_a1_${providerState}`,
    )).toBe("fresh-attempt-access");
    expect(mocks.cookieStore.values.has("spotify_access_token")).toBe(false);
  });

  it.each([
    {
      provider: "spotify" as const,
      owner: "spotify_token_owner",
      access: "spotify_access_token",
      refresh: "spotify_refresh_token",
      pending: "spotify_oauth_state",
      secret: "spotify-secret",
      getAccessToken: getSpotifyAccessToken,
    },
    {
      provider: "strava" as const,
      owner: "strava_token_owner",
      access: "strava_access_token",
      refresh: "strava_refresh_token",
      pending: "strava_oauth_state",
      secret: "strava-secret",
      getAccessToken: getStravaAccessToken,
    },
  ])("preserves B when a late $provider refresh lands after B credentials", async ({
    provider,
    owner,
    access,
    refresh,
    pending,
    secret,
    getAccessToken,
  }) => {
    const userB = "provider-user-b";
    const subjectB = profileSubjectForUserId(userB);
    mocks.cookieStore.values.set(owner, createProviderOwnerSeal(provider, subject, secret));
    mocks.cookieStore.values.set(refresh, "refresh-a");
    const exchange = deferred<Response>();
    const providerFetch = vi.fn(() => exchange.promise);
    vi.stubGlobal("fetch", providerFetch);

    const lateRefresh = getAccessToken(userId);
    await Promise.resolve();
    mocks.cookieStore.values.set(owner, createProviderOwnerSeal(provider, subjectB, secret));
    mocks.cookieStore.values.set(access, "access-b");
    mocks.cookieStore.values.set(refresh, "refresh-b");
    mocks.cookieStore.values.set(pending, "pending-b");
    exchange.resolve(new Response(JSON.stringify({
      access_token: "late-access-a",
      refresh_token: "late-refresh-a",
      expires_in: 900,
    }), { status: 200 }));

    await expect(lateRefresh).resolves.toBe("late-access-a");
    expect(mocks.cookieStore.values.get(owner)).toBe(
      createProviderOwnerSeal(provider, subjectB, secret),
    );
    expect(mocks.cookieStore.values.get(access)).toBe("access-b");
    expect(mocks.cookieStore.values.get(refresh)).toBe("refresh-b");
    expect(mocks.cookieStore.values.get(pending)).toBe("pending-b");
    expect([...mocks.cookieStore.values.values()]).toContain("late-access-a");
    expect([...mocks.cookieStore.values.values()]).toContain("late-refresh-a");

    await expect(getAccessToken(userB)).resolves.toBe("access-b");
    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(mocks.cookieStore.values.get(access)).toBe("access-b");
  });

  it.each([
    {
      provider: "spotify" as const,
      owner: "spotify_token_owner",
      access: "spotify_access_token",
      refresh: "spotify_refresh_token",
      pending: "spotify_oauth_state",
      secret: "spotify-secret",
      getAccessToken: getSpotifyAccessToken,
    },
    {
      provider: "strava" as const,
      owner: "strava_token_owner",
      access: "strava_access_token",
      refresh: "strava_refresh_token",
      pending: "strava_oauth_state",
      secret: "strava-secret",
      getAccessToken: getStravaAccessToken,
    },
  ])("preserves B when a late $provider invalid_grant lands during B OAuth", async ({
    provider,
    owner,
    access,
    refresh,
    pending,
    secret,
    getAccessToken,
  }) => {
    const userB = "provider-user-b";
    const subjectB = profileSubjectForUserId(userB);
    mocks.cookieStore.values.set(owner, createProviderOwnerSeal(provider, subject, secret));
    mocks.cookieStore.values.set(refresh, "refresh-a");
    const exchange = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(() => exchange.promise));

    const lateRefresh = getAccessToken(userId);
    await Promise.resolve();
    mocks.cookieStore.values.set(owner, createProviderOwnerSeal(provider, subjectB, secret));
    mocks.cookieStore.values.set(access, "access-b");
    mocks.cookieStore.values.set(refresh, "refresh-b");
    const { sealedState } = createOAuthPendingState({
      provider,
      subject: subjectB,
      secret,
      nonce: "b".repeat(43),
    });
    mocks.cookieStore.values.set(pending, sealedState);
    exchange.resolve(new Response(JSON.stringify({ error: "invalid_grant" }), {
      status: 400,
    }));

    await expect(lateRefresh).resolves.toBeNull();
    expect(mocks.cookieStore.values.get(owner)).toBe(
      createProviderOwnerSeal(provider, subjectB, secret),
    );
    expect(mocks.cookieStore.values.get(access)).toBe("access-b");
    expect(mocks.cookieStore.values.get(refresh)).toBe("refresh-b");
    expect(mocks.cookieStore.values.get(pending)).toBe(sealedState);
    await expect(getAccessToken(userB)).resolves.toBe("access-b");
  });

  it.each([
    {
      provider: "spotify" as const,
      owner: "spotify_token_owner",
      refresh: "spotify_refresh_token",
      secret: "spotify-secret",
      getAccessToken: getSpotifyAccessToken,
    },
    {
      provider: "strava" as const,
      owner: "strava_token_owner",
      refresh: "strava_refresh_token",
      secret: "strava-secret",
      getAccessToken: getStravaAccessToken,
    },
  ])("fails a rejected $provider refresh closed without cookie mutation", async ({
    provider,
    owner,
    refresh,
    secret,
    getAccessToken,
  }) => {
    const ownerSeal = createProviderOwnerSeal(provider, subject, secret);
    mocks.cookieStore.values.set(owner, ownerSeal);
    mocks.cookieStore.values.set(refresh, "refresh-a");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("Timed out", "AbortError")));

    await expect(getAccessToken(userId)).rejects.toMatchObject({
      name: "DirectProviderRefreshError",
      status: 504,
      code: "PROVIDER_REFRESH_TIMEOUT",
    } satisfies Partial<DirectProviderRefreshError>);
    expect(mocks.cookieStore.values.get(owner)).toBe(ownerSeal);
    expect(mocks.cookieStore.values.get(refresh)).toBe("refresh-a");
    expect(mocks.cookieStore.set).not.toHaveBeenCalled();
    expect(mocks.cookieStore.delete).not.toHaveBeenCalled();
  });

  it.each([
    {
      provider: "spotify" as const,
      owner: "spotify_token_owner",
      refresh: "spotify_refresh_token",
      secret: "spotify-secret",
      getAccessToken: getSpotifyAccessToken,
    },
    {
      provider: "strava" as const,
      owner: "strava_token_owner",
      refresh: "strava_refresh_token",
      secret: "strava-secret",
      getAccessToken: getStravaAccessToken,
    },
  ])("distinguishes transient and malformed $provider refresh responses", async ({
    provider,
    owner,
    refresh,
    secret,
    getAccessToken,
  }) => {
    mocks.cookieStore.values.set(
      owner,
      createProviderOwnerSeal(provider, subject, secret),
    );
    mocks.cookieStore.values.set(refresh, "refresh-a");
    const providerFetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ expires_in: 900 }), {
        status: 200,
      }));
    vi.stubGlobal("fetch", providerFetch);

    await expect(getAccessToken(userId)).rejects.toMatchObject({
      status: 502,
      code: "PROVIDER_REFRESH_UNAVAILABLE",
    } satisfies Partial<DirectProviderRefreshError>);
    await expect(getAccessToken(userId)).rejects.toMatchObject({
      status: 502,
      code: "PROVIDER_REFRESH_INVALID_RESPONSE",
    } satisfies Partial<DirectProviderRefreshError>);
    expect(mocks.cookieStore.values.get(refresh)).toBe("refresh-a");
  });

  it.each([
    {
      provider: "spotify" as const,
      owner: "spotify_token_owner",
      refresh: "spotify_refresh_token",
      secret: "spotify-secret",
      getAccessToken: getSpotifyAccessToken,
    },
    {
      provider: "strava" as const,
      owner: "strava_token_owner",
      refresh: "strava_refresh_token",
      secret: "strava-secret",
      getAccessToken: getStravaAccessToken,
    },
  ])("preserves $provider credentials for non-revocation 4xx failures", async ({
    provider,
    owner,
    refresh,
    secret,
    getAccessToken,
  }) => {
    const ownerSeal = createProviderOwnerSeal(provider, subject, secret);
    mocks.cookieStore.values.set(owner, ownerSeal);
    mocks.cookieStore.values.set(refresh, "refresh-a");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: "invalid_client",
    }), { status: 401 })));

    await expect(getAccessToken(userId)).rejects.toMatchObject({
      status: 502,
      code: "PROVIDER_REFRESH_UNAVAILABLE",
    } satisfies Partial<DirectProviderRefreshError>);
    expect(mocks.cookieStore.values.get(owner)).toBe(ownerSeal);
    expect(mocks.cookieStore.values.get(refresh)).toBe("refresh-a");
  });

  it.each([
    {
      provider: "spotify" as const,
      owner: "spotify_token_owner",
      access: "spotify_access_token",
      refresh: "spotify_refresh_token",
      secret: "spotify-secret",
      getAccessToken: getSpotifyAccessToken,
    },
    {
      provider: "strava" as const,
      owner: "strava_token_owner",
      access: "strava_access_token",
      refresh: "strava_refresh_token",
      secret: "strava-secret",
      getAccessToken: getStravaAccessToken,
    },
  ])("treats a definitive $provider refresh rejection as disconnected", async ({
    provider,
    owner,
    access,
    refresh,
    secret,
    getAccessToken,
  }) => {
    mocks.cookieStore.values.set(
      owner,
      createProviderOwnerSeal(provider, subject, secret),
    );
    mocks.cookieStore.values.set(refresh, "revoked-refresh");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: "invalid_grant" }),
      { status: 400 },
    )));

    await expect(getAccessToken(userId)).resolves.toBeNull();
    expect(mocks.cookieStore.values.has(owner)).toBe(false);
    expect(mocks.cookieStore.values.has(access)).toBe(false);
    expect(mocks.cookieStore.values.has(refresh)).toBe(false);
  });
});
