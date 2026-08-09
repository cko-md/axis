import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { profileSubjectForUserId } from "@/lib/auth/profileSubject.server";
import {
  createProviderOwnerSeal,
  providerTokensForSubject,
  type MutableProviderCookieStore,
} from "@/lib/auth/providerCookies.server";

type CookieOperation =
  | { kind: "set"; name: string; value: string }
  | { kind: "delete"; name: string };

type TestCookieStore = MutableProviderCookieStore & {
  values: Map<string, string>;
  operations: CookieOperation[];
};

const mocks = vi.hoisted(() => ({
  stores: [] as TestCookieStore[],
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => {
    const store = mocks.stores.shift();
    if (!store) throw new Error("TEST_COOKIE_STORE_MISSING");
    return store;
  }),
}));

import { getAccessToken as getSpotifyAccessToken } from "./spotify/_lib";
import { getAccessToken as getStravaAccessToken } from "./strava/_lib";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function cookieStore(values: Map<string, string> = new Map()): TestCookieStore {
  const operations: CookieOperation[] = [];
  return {
    values: new Map(values),
    operations,
    get(name) {
      const value = this.values.get(name);
      return value === undefined ? undefined : { value };
    },
    getAll() {
      return [...this.values].map(([name, value]) => ({ name, value }));
    },
    set(name, value) {
      operations.push({ kind: "set", name, value });
      this.values.set(name, value);
    },
    delete(name) {
      operations.push({ kind: "delete", name });
      this.values.delete(name);
    },
  };
}

function applyOperations(target: Map<string, string>, operations: CookieOperation[]) {
  for (const operation of operations) {
    if (operation.kind === "set") target.set(operation.name, operation.value);
    else target.delete(operation.name);
  }
}

describe("AUTH-006 concurrent direct-provider refresh containment", () => {
  const userId = "concurrent-provider-user";
  const subject = profileSubjectForUserId(userId);

  beforeEach(() => {
    mocks.stores.length = 0;
    process.env.SPOTIFY_CLIENT_ID = "spotify-client";
    process.env.SPOTIFY_CLIENT_SECRET = "spotify-secret";
    process.env.STRAVA_CLIENT_ID = "strava-client";
    process.env.STRAVA_CLIENT_SECRET = "strava-secret";
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
      refresh: "spotify_refresh_token",
      secret: "spotify-secret",
      freshAccess: "spotify-access-v2",
      freshRefresh: "spotify-refresh-v2",
      getAccessToken: getSpotifyAccessToken,
    },
    {
      provider: "strava" as const,
      owner: "strava_token_owner",
      refresh: "strava_refresh_token",
      secret: "strava-secret",
      freshAccess: "strava-access-v2",
      freshRefresh: "strava-refresh-v2",
      getAccessToken: getStravaAccessToken,
    },
  ])("keeps a successful $provider rotation when a same-snapshot invalid_grant lands last", async ({
    provider,
    owner,
    refresh,
    secret,
    freshAccess,
    freshRefresh,
    getAccessToken,
  }) => {
    const browser = new Map<string, string>([
      [owner, createProviderOwnerSeal(provider, subject, secret)],
      [refresh, `${provider}-refresh-v1`],
    ]);
    const winnerStore = cookieStore(browser);
    const loserStore = cookieStore(browser);
    mocks.stores.push(winnerStore, loserStore);

    const winnerResponse = deferred<Response>();
    const loserResponse = deferred<Response>();
    const providerFetch = vi.fn()
      .mockImplementationOnce(() => winnerResponse.promise)
      .mockImplementationOnce(() => loserResponse.promise);
    vi.stubGlobal("fetch", providerFetch);

    const winner = getAccessToken(userId);
    const loser = getAccessToken(userId);
    await Promise.resolve();
    expect(providerFetch).toHaveBeenCalledTimes(2);

    winnerResponse.resolve(new Response(JSON.stringify({
      access_token: freshAccess,
      refresh_token: freshRefresh,
      expires_in: 900,
    }), { status: 200 }));
    await expect(winner).resolves.toBe(freshAccess);

    loserResponse.resolve(new Response(JSON.stringify({ error: "invalid_grant" }), {
      status: 400,
    }));
    await expect(loser).resolves.toBeNull();

    expect(winnerStore.operations.length).toBeGreaterThan(0);
    expect(loserStore.operations).toEqual([]);
    applyOperations(browser, winnerStore.operations);
    applyOperations(browser, loserStore.operations);

    const finalStore = cookieStore(browser);
    expect(providerTokensForSubject(finalStore, provider, subject, secret)).toMatchObject({
      accessToken: freshAccess,
      refreshToken: freshRefresh,
    });
    expect(finalStore.operations).toEqual([]);
  });
});
