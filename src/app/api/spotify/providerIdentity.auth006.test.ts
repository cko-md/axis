import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { EXPECTED_PROFILE_SUBJECT_HEADER } from "@/lib/auth/profileSubject";
import { profileSubjectForUserId } from "@/lib/auth/profileSubject.server";
import { createOAuthPendingState } from "@/lib/auth/oauthState.server";
import { createProviderOwnerSeal } from "@/lib/auth/providerCookies.server";
import {
  DIRECT_PROVIDER_EXCHANGE_MAX_BYTES,
  DIRECT_PROVIDER_EXCHANGE_TIMEOUT_MS,
} from "@/lib/auth/directProviderFetch.server";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  cookieStore: {
    values: new Map<string, string>(),
    operations: [] as string[],
    get: vi.fn((name: string) => {
      const value = mocks.cookieStore.values.get(name);
      return value === undefined ? undefined : { name, value };
    }),
    getAll: vi.fn(() => [...mocks.cookieStore.values].map(([name, value]) => ({ name, value }))),
    set: vi.fn((name: string, value: string) => {
      mocks.cookieStore.operations.push(`set:${name}`);
      mocks.cookieStore.values.set(name, value);
    }),
    delete: vi.fn((name: string) => {
      mocks.cookieStore.operations.push(`delete:${name}`);
      mocks.cookieStore.values.delete(name);
    }),
  },
  captureRouteError: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => mocks.cookieStore) }));
vi.mock("@/lib/observability/captureRouteError", () => ({
  captureRouteError: mocks.captureRouteError,
}));

import { POST as startSpotifyAuth } from "./auth/route";
import { GET as completeSpotifyAuth } from "./callback/route";
import { POST as disconnectSpotify } from "./disconnect/route";

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

describe("AUTH-006 Spotify server identity boundary", () => {
  const userA = "spotify-user-a";
  const userB = "spotify-user-b";
  const subjectA = profileSubjectForUserId(userA);
  const subjectB = profileSubjectForUserId(userB);
  const secret = "spotify-test-secret";

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cookieStore.values.clear();
    mocks.cookieStore.operations.length = 0;
    process.env.SPOTIFY_CLIENT_ID = "spotify-client";
    process.env.SPOTIFY_CLIENT_SECRET = secret;
    process.env.DIRECT_PROVIDER_COOKIE_SECRET =
      "axis-test-direct-provider-cookie-secret-v2";
    process.env.DIRECT_PROVIDER_COOKIE_V1_ACCEPT_UNTIL =
      "2099-01-01T00:00:00.000Z";
    delete process.env.NEXT_PUBLIC_APP_URL;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.SPOTIFY_CLIENT_ID;
    delete process.env.SPOTIFY_CLIENT_SECRET;
    delete process.env.DIRECT_PROVIDER_COOKIE_SECRET;
    delete process.env.DIRECT_PROVIDER_COOKIE_V1_ACCEPT_UNTIL;
  });

  it("requires a current expected subject before issuing OAuth state", async () => {
    authenticatedAs(userA);
    const rejected = await startSpotifyAuth(new NextRequest("https://axis.test/api/spotify/auth", {
      method: "POST",
    }));
    expect(rejected.status).toBe(409);
    expect(mocks.cookieStore.set).not.toHaveBeenCalled();

    const accepted = await startSpotifyAuth(new NextRequest("https://axis.test/api/spotify/auth", {
      method: "POST",
      headers: { [EXPECTED_PROFILE_SUBJECT_HEADER]: subjectA },
    }));
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    const body = await accepted.json() as { url: string };
    const providerUrl = new URL(body.url);
    expect(providerUrl.origin).toBe("https://accounts.spotify.com");
    expect(providerUrl.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const pendingEntry = [...mocks.cookieStore.values.entries()].find(([name]) =>
      name.startsWith("spotify_oauth_state_a1_"));
    expect(pendingEntry?.[1]).toContain(".");
    expect(mocks.cookieStore.values.has("spotify_oauth_state")).toBe(false);
    expect(body.url).not.toContain(userA);
    expect(body.url).not.toContain(subjectA);
  });

  it("preserves unmatched legacy state when the authenticated subject changes", async () => {
    const nonce = "n".repeat(43);
    const { providerState, sealedState } = createOAuthPendingState({
      provider: "spotify",
      subject: subjectA,
      secret,
      nonce,
    });
    mocks.cookieStore.values.set("spotify_oauth_state", sealedState);
    authenticatedAs(userB);
    const providerFetch = vi.fn();
    vi.stubGlobal("fetch", providerFetch);

    const response = await completeSpotifyAuth(new NextRequest(
      `https://axis.test/api/spotify/callback?code=secret-code&state=${providerState}`,
    ));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("reason=state_invalid");
    expect(response.headers.get("location")).not.toContain("secret-code");
    expect(response.headers.get("location")).not.toContain(providerState);
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(mocks.cookieStore.values.get("spotify_oauth_state")).toBe(sealedState);
    expect(mocks.cookieStore.operations).not.toContain("delete:spotify_oauth_state");
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("does not let a stale callback consume the current subject's pending slot", async () => {
    authenticatedAs(userB);
    const started = await startSpotifyAuth(new NextRequest(
      "https://axis.test/api/spotify/auth",
      {
        method: "POST",
        headers: { [EXPECTED_PROFILE_SUBJECT_HEADER]: subjectB },
      },
    ));
    const startedBody = await started.json() as { url: string };
    const providerState = new URL(startedBody.url).searchParams.get("state");
    const pendingName = [...mocks.cookieStore.values.keys()].find((name) =>
      name.startsWith("spotify_oauth_state_a1_"));
    expect(providerState).toBeTruthy();
    expect(pendingName).toBeTruthy();

    const providerFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: "access-b",
      refresh_token: "refresh-b",
      expires_in: 900,
    }), { status: 200 }));
    vi.stubGlobal("fetch", providerFetch);
    const stale = await completeSpotifyAuth(new NextRequest(
      `https://axis.test/api/spotify/callback?code=stale-a&state=${"a".repeat(43)}`,
    ));
    expect(stale.headers.get("location")).toContain("reason=state_invalid");
    expect(mocks.cookieStore.values.has(pendingName!)).toBe(true);
    expect(providerFetch).not.toHaveBeenCalled();

    const validUrl = `https://axis.test/api/spotify/callback?code=code-b&state=${providerState}`;
    const valid = await completeSpotifyAuth(new NextRequest(validUrl));
    expect(valid.headers.get("location")).toContain("status=ok");
    expect(mocks.cookieStore.values.has(pendingName!)).toBe(false);
    expect(providerFetch).toHaveBeenCalledOnce();

    const replay = await completeSpotifyAuth(new NextRequest(validUrl));
    expect(replay.headers.get("location")).toContain("reason=state_invalid");
    expect(providerFetch).toHaveBeenCalledOnce();
  });

  it("consumes pending state before route-level authentication failure", async () => {
    mocks.cookieStore.values.set(
      "spotify_oauth_state",
      createOAuthPendingState({
        provider: "spotify",
        subject: subjectA,
        secret,
      }).sealedState,
    );
    mocks.createClient.mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: null }),
      },
    });
    const providerFetch = vi.fn();
    vi.stubGlobal("fetch", providerFetch);

    const response = await completeSpotifyAuth(new NextRequest(
      "https://axis.test/api/spotify/callback?code=secret-code&state=opaque-state",
    ));

    expect(response.headers.get("location")).toContain("reason=session_expired");
    expect(mocks.cookieStore.operations[0]).toBe("delete:spotify_oauth_state");
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("disconnect clears tokens, owner binding, and pending OAuth state", async () => {
    authenticatedAs(userA);
    mocks.cookieStore.values.set(
      "spotify_token_owner",
      createProviderOwnerSeal("spotify", subjectA, secret),
    );
    mocks.cookieStore.values.set("spotify_access_token", "access");
    mocks.cookieStore.values.set("spotify_refresh_token", "refresh");
    mocks.cookieStore.values.set(
      "spotify_oauth_state",
      createOAuthPendingState({
        provider: "spotify",
        subject: subjectA,
        secret,
      }).sealedState,
    );

    const response = await disconnectSpotify(new Request(
      "https://axis.test/api/spotify/disconnect",
      {
        method: "POST",
        headers: { [EXPECTED_PROFILE_SUBJECT_HEADER]: subjectA },
      },
    ));

    expect(response.status).toBe(200);
    expect(mocks.cookieStore.values.has("spotify_token_owner")).toBe(false);
    expect(mocks.cookieStore.values.has("spotify_access_token")).toBe(false);
    expect(mocks.cookieStore.values.has("spotify_refresh_token")).toBe(false);
    expect(mocks.cookieStore.values.has("spotify_oauth_state")).toBe(false);
    const cutoff = [...mocks.cookieStore.values.entries()].find(([name]) =>
      name.startsWith("spotify_token_owner_cut2_"));
    expect(cutoff?.[1]).toMatch(/^pc2_[A-Za-z0-9_-]{43}$/);
  });

  it("fails disconnect visibly without owner sealing and preserves browser state", async () => {
    const nonce = "u".repeat(43);
    for (const name of [
      "spotify_access_token",
      "spotify_refresh_token",
      "spotify_token_owner",
      "spotify_oauth_state",
      `spotify_access_token_a1_${nonce}`,
      `spotify_refresh_token_a1_${nonce}`,
      `spotify_token_owner_a1_${nonce}`,
      `spotify_oauth_state_a1_${nonce}`,
      "spotify_access_token_s1_subject-slot",
      "spotify_refresh_token_s1_subject-slot",
      "spotify_token_owner_s1_subject-slot",
      "spotify_token_owner_cut1_subject-slot_cutoff",
    ]) {
      mocks.cookieStore.values.set(name, "opaque");
    }
    const before = new Map(mocks.cookieStore.values);
    delete process.env.SPOTIFY_CLIENT_SECRET;
    authenticatedAs(userA);

    const response = await disconnectSpotify(new Request(
      "https://axis.test/api/spotify/disconnect",
      {
        method: "POST",
        headers: { [EXPECTED_PROFILE_SUBJECT_HEADER]: subjectA },
      },
    ));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "PROVIDER_NOT_CONFIGURED" });
    expect(mocks.cookieStore.values).toEqual(before);
    expect(mocks.cookieStore.operations).toEqual([]);
  });

  it("completes post-disconnect authorization across multi-second clock skew", async () => {
    const slowNow = Date.UTC(2026, 7, 8, 12, 0, 0);
    authenticatedAs(userA);
    const clock = vi.spyOn(Date, "now");
    try {
      clock.mockReturnValue(slowNow + 5_000);
      const disconnected = await disconnectSpotify(new Request(
        "https://axis.test/api/spotify/disconnect",
        {
          method: "POST",
          headers: { [EXPECTED_PROFILE_SUBJECT_HEADER]: subjectA },
        },
      ));
      expect(disconnected.status).toBe(200);

      clock.mockReturnValue(slowNow);
      const started = await startSpotifyAuth(new NextRequest(
        "https://axis.test/api/spotify/auth",
        {
          method: "POST",
          headers: { [EXPECTED_PROFILE_SUBJECT_HEADER]: subjectA },
        },
      ));
      const providerState = new URL(
        ((await started.json()) as { url: string }).url,
      ).searchParams.get("state");
      expect(providerState).toBeTruthy();

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
        access_token: "skew-access",
        refresh_token: "skew-refresh",
        expires_in: 900,
      }), { status: 200 })));
      clock.mockReturnValue(slowNow + 500);
      const callback = await completeSpotifyAuth(new NextRequest(
        `https://axis.test/api/spotify/callback?code=skew-code&state=${providerState}`,
      ));
      expect(callback.headers.get("location")).toContain("provider=spotify&status=ok");
      expect(
        mocks.cookieStore.values.get(`spotify_access_token_a1_${providerState}`),
      ).toBe("skew-access");
    } finally {
      clock.mockRestore();
    }
  });

  it("publishes owner-bound tokens only after a valid single-use callback", async () => {
    const nonce = "n".repeat(43);
    const { providerState, sealedState } = createOAuthPendingState({
      provider: "spotify",
      subject: subjectA,
      secret,
      nonce,
    });
    mocks.cookieStore.values.set("spotify_oauth_state", sealedState);
    authenticatedAs(userA);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 900,
    }), { status: 200 })));

    const response = await completeSpotifyAuth(new NextRequest(
      `https://axis.test/api/spotify/callback?code=provider-code&state=${providerState}`,
    ));

    expect(response.headers.get("location")).toContain("provider=spotify&status=ok");
    const attemptSuffix = `_a1_${providerState}`;
    const attemptOwner = mocks.cookieStore.values.get(
      `spotify_token_owner${attemptSuffix}`,
    );
    expect(attemptOwner).toMatch(/^pa2_[0-9a-z]+_[A-Za-z0-9_-]{43}$/);
    expect(attemptOwner).not.toContain(subjectA);
    expect(mocks.cookieStore.values.get(`spotify_access_token${attemptSuffix}`)).toBe(
      "new-access",
    );
    expect(mocks.cookieStore.values.get(`spotify_refresh_token${attemptSuffix}`)).toBe(
      "new-refresh",
    );
    expect(mocks.cookieStore.operations[0]).toBe("delete:spotify_oauth_state");
    expect(mocks.cookieStore.operations.at(-1)).toBe(
      `set:spotify_token_owner${attemptSuffix}`,
    );
  });

  it("classifies an oversized token response as a 502 provider failure", async () => {
    const { providerState, sealedState } = createOAuthPendingState({
      provider: "spotify",
      subject: subjectA,
      secret,
      nonce: "o".repeat(43),
    });
    mocks.cookieStore.values.set("spotify_oauth_state", sealedState);
    authenticatedAs(userA);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", {
      status: 400,
      headers: {
        "Content-Length": String(DIRECT_PROVIDER_EXCHANGE_MAX_BYTES + 1),
      },
    })));

    const response = await completeSpotifyAuth(new NextRequest(
      `https://axis.test/api/spotify/callback?code=provider-code&state=${providerState}`,
    ));

    expect(response.headers.get("location")).toContain("reason=token_exchange_failed");
    expect(mocks.captureRouteError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ status: 502, code: "SPOTIFY_TOKEN_EXCHANGE_FAILED" }),
    );
  });

  it("returns terminal safe feedback when the token exchange times out", async () => {
    vi.useFakeTimers();
    try {
      const { providerState, sealedState } = createOAuthPendingState({
        provider: "spotify",
        subject: subjectA,
        secret,
        nonce: "t".repeat(43),
      });
      mocks.cookieStore.values.set("spotify_oauth_state", sealedState);
      authenticatedAs(userA);
      vi.stubGlobal("fetch", vi.fn((_url: URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Timed out", "AbortError"));
          }, { once: true });
        })));

      const pending = completeSpotifyAuth(new NextRequest(
        `https://axis.test/api/spotify/callback?code=provider-code&state=${providerState}`,
      ));
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(DIRECT_PROVIDER_EXCHANGE_TIMEOUT_MS);
      const response = await pending;

      expect(response.headers.get("location")).toContain("reason=token_exchange_failed");
      expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
      expect(mocks.cookieStore.operations[0]).toBe("delete:spotify_oauth_state");
      expect(mocks.cookieStore.values.has("spotify_access_token")).toBe(false);
      expect(mocks.cookieStore.values.has("spotify_token_owner")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
