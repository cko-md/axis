import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { profileSubjectForUserId } from "@/lib/auth/profileSubject.server";
import { directProviderCookieKeyring } from "@/lib/auth/directProviderKeyring.server";
import {
  markProviderRefreshRejectedForSubject,
  providerTokensForSubject,
  providerRefreshRejectedForSubject,
  replaceProviderTokenCookies,
  type MutableProviderCookieStore,
} from "@/lib/auth/providerCookies.server";

type CookieOperation =
  | { kind: "set"; name: string; value: string; maxAge: number }
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
    set(name, value, options) {
      operations.push({ kind: "set", name, value, maxAge: options.maxAge });
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

  it("binds a terminal marker to the exact OAuth attempt even when token text repeats", () => {
    const store = cookieStore();
    const oldAttempt = {
      providerState: "a".repeat(43),
      authorizationOrder: 100,
    };
    const newAttempt = {
      providerState: "b".repeat(43),
      authorizationOrder: 101,
    };
    markProviderRefreshRejectedForSubject(
      store,
      "spotify",
      subject,
      "spotify-secret",
      "provider-reused-refresh-token",
      "legacy",
      oldAttempt,
    );

    expect(providerRefreshRejectedForSubject(
      store,
      "spotify",
      subject,
      "spotify-secret",
      "provider-reused-refresh-token",
      "legacy",
      oldAttempt,
    )).toBe(true);
    expect(providerRefreshRejectedForSubject(
      store,
      "spotify",
      subject,
      "spotify-secret",
      "provider-reused-refresh-token",
      "legacy",
      newAttempt,
    )).toBe(false);
    expect([...store.values.keys()].join(" ")).not.toContain("provider-reused-refresh-token");
    expect([...store.values.values()].join(" ")).not.toContain("provider-reused-refresh-token");
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
      secret: "spotify-secret",
      freshAccess: "spotify-access-v2",
      freshRefresh: "spotify-refresh-v1",
      getAccessToken: getSpotifyAccessToken,
    },
    {
      provider: "strava" as const,
      owner: "strava_token_owner",
      secret: "strava-secret",
      freshAccess: "strava-access-v2",
      freshRefresh: "strava-refresh-v2",
      getAccessToken: getStravaAccessToken,
    },
  ])("keeps a successful $provider rotation when a same-snapshot invalid_grant lands last", async ({
    provider,
    owner,
    secret,
    freshAccess,
    freshRefresh,
    getAccessToken,
  }) => {
    const bootstrap = cookieStore();
    replaceProviderTokenCookies(
      bootstrap,
      provider,
      {
        accessToken: `${provider}-expired-access`,
        refreshToken: `${provider}-refresh-v1`,
      },
      subject,
      secret,
    );
    const subjectOwner = [...bootstrap.values.keys()].find((name) =>
      name.startsWith(`${owner}_s1_`));
    const subjectAccess = [...bootstrap.values.keys()].find((name) =>
      name.startsWith(`${provider}_access_token_s1_`));
    if (!subjectOwner || !subjectAccess) throw new Error("TEST_SUBJECT_SLOT_MISSING");
    bootstrap.values.set(subjectOwner, "corrupt-owner");
    bootstrap.values.delete(subjectAccess);
    bootstrap.values.delete(`${provider}_access_token`);
    bootstrap.operations.length = 0;
    const browser = new Map(bootstrap.values);
    const initialBrowser = new Map(browser);
    const winnerStore = cookieStore(browser);
    const loserStore = cookieStore(browser);
    mocks.stores.push(winnerStore, loserStore);

    const winnerResponse = deferred<Response>();
    const providerFetch = vi.fn()
      .mockImplementationOnce(() => winnerResponse.promise);
    vi.stubGlobal("fetch", providerFetch);

    const winner = getAccessToken(userId);
    const loser = getAccessToken(userId);
    const loserAssertion = expect(loser).rejects.toMatchObject({
      status: 409,
      code: "PROVIDER_REFRESH_IN_PROGRESS",
    });
    await Promise.resolve();
    expect(providerFetch).toHaveBeenCalledTimes(1);

    winnerResponse.resolve(new Response(JSON.stringify({
      access_token: freshAccess,
      refresh_token: freshRefresh,
      expires_in: 900,
    }), { status: 200 }));
    await expect(winner).resolves.toBe(freshAccess);

    await loserAssertion;

    expect(winnerStore.operations.length).toBeGreaterThan(0);
    expect(loserStore.operations).toHaveLength(0);
    applyOperations(browser, winnerStore.operations);
    applyOperations(browser, loserStore.operations);

    const finalStore = cookieStore(browser);
    expect(providerTokensForSubject(
      finalStore,
      provider,
      subject,
      directProviderCookieKeyring(secret),
    )).toMatchObject({
      accessToken: freshAccess,
      refreshToken: freshRefresh,
    });
    expect(finalStore.operations).toEqual([]);

    const inverseBrowser = new Map(initialBrowser);
    applyOperations(inverseBrowser, loserStore.operations);
    applyOperations(inverseBrowser, winnerStore.operations);
    expect(providerTokensForSubject(
      cookieStore(inverseBrowser),
      provider,
      subject,
      directProviderCookieKeyring(secret),
    )).toMatchObject({
      accessToken: freshAccess,
      refreshToken: freshRefresh,
    });

    const resumedBrowser = new Map(browser);
    const refreshedAccess = [...resumedBrowser.keys()].find((name) =>
      name.startsWith(`${provider}_access_token_s2_`));
    if (!refreshedAccess) throw new Error("TEST_REFRESHED_SUBJECT_SLOT_MISSING");
    resumedBrowser.delete(refreshedAccess);
    const resumedStore = cookieStore(resumedBrowser);
    mocks.stores.push(resumedStore);
    providerFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      access_token: `${provider}-access-v3`,
      refresh_token: freshRefresh,
      expires_in: 900,
    }), { status: 200 }));
    await expect(getAccessToken(userId)).resolves.toBe(`${provider}-access-v3`);
    expect(providerFetch).toHaveBeenCalledTimes(2);
  });
});
