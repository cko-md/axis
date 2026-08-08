import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { profileSubjectForUserId } from "@/lib/auth/profileSubject.server";
import { createProviderOwnerSeal } from "@/lib/auth/providerCookies.server";

const mocks = vi.hoisted(() => ({
  cookieStore: {
    values: new Map<string, string>(),
    get: vi.fn((name: string) => {
      const value = mocks.cookieStore.values.get(name);
      return value === undefined ? undefined : { name, value };
    }),
    set: vi.fn((name: string, value: string) => mocks.cookieStore.values.set(name, value)),
    delete: vi.fn((name: string) => mocks.cookieStore.values.delete(name)),
  },
}));

vi.mock("next/headers", () => ({ cookies: vi.fn(async () => mocks.cookieStore) }));

import { getAccessToken as getSpotifyAccessToken } from "./spotify/_lib";
import { getAccessToken as getStravaAccessToken } from "./strava/_lib";

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
  ])("clears invalid $provider ownership before provider traffic", async ({
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

    expect(mocks.cookieStore.values.has(owner)).toBe(false);
    expect(mocks.cookieStore.values.has(access)).toBe(false);
    expect(mocks.cookieStore.values.has(refresh)).toBe(false);
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
    expect(mocks.cookieStore.values.has("spotify_access_token")).toBe(false);
  });
});
