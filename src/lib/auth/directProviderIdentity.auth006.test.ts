import { describe, expect, it, vi } from "vitest";
import { validateExpectedProfileSubject } from "./expectedProfileSubject.server";
import {
  createOAuthPendingState,
  oauthPendingStateBelongsToSubject,
  OAUTH_STATE_TTL_SECONDS,
  verifyOAuthPendingState,
} from "./oauthState.server";
import { EXPECTED_PROFILE_SUBJECT_HEADER } from "./profileSubject";
import { profileSubjectForUserId } from "./profileSubject.server";
import {
  clearProviderCredentialCookiesForSubject,
  clearProviderTokenCookiesForSubject,
  consumeOAuthPendingStateCookie,
  consumeOAuthPendingStateCookieForAttempt,
  createProviderOwnerSeal,
  providerTokensForSubject,
  replaceProviderTokenCookies,
  replaceProviderTokenCookiesForAttempt,
  replaceRefreshedProviderTokenCookies,
  setOAuthPendingStateCookie,
  type MutableProviderCookieStore,
} from "./providerCookies.server";

class MemoryCookieStore implements MutableProviderCookieStore {
  readonly values = new Map<string, string>();
  readonly operations: string[] = [];

  get(name: string) {
    const value = this.values.get(name);
    return value === undefined ? undefined : { value };
  }

  getAll() {
    return [...this.values].map(([name, value]) => ({ name, value }));
  }

  set(name: string, value: string) {
    this.operations.push(`set:${name}`);
    this.values.set(name, value);
  }

  delete(name: string) {
    this.operations.push(`delete:${name}`);
    this.values.delete(name);
  }
}

describe("AUTH-006 direct-provider identity primitives", () => {
  const userA = "auth-user-a";
  const userB = "auth-user-b";
  const subjectA = profileSubjectForUserId(userA);
  const subjectB = profileSubjectForUserId(userB);
  const secret = "test-provider-secret";
  const nowMs = Date.UTC(2026, 7, 7, 12, 0, 0);

  it("fails closed with one private response for missing, malformed, and stale subjects", async () => {
    for (const header of [undefined, "user-a", subjectB]) {
      const headers = new Headers();
      if (header) headers.set(EXPECTED_PROFILE_SUBJECT_HEADER, header);
      const result = validateExpectedProfileSubject(
        new Request("https://axis.test/api/provider", { headers }),
        userA,
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected subject validation to fail");
      expect(result.response.status).toBe(409);
      expect(result.response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
      expect(await result.response.json()).toEqual({ error: "SUBJECT_CHANGED" });
    }

    const accepted = validateExpectedProfileSubject(new Request("https://axis.test/api/provider", {
      headers: { [EXPECTED_PROFILE_SUBJECT_HEADER]: subjectA },
    }), userA);
    expect(accepted).toEqual({ ok: true, subject: subjectA });
  });

  it("binds signed state to provider, opaque subject, nonce, and a strict lifetime", () => {
    const nonce = "n".repeat(43);
    const { providerState, sealedState } = createOAuthPendingState({
      provider: "spotify",
      subject: subjectA,
      secret,
      nonce,
      nowMs,
    });

    expect(providerState).toBe(nonce);
    expect(providerState).not.toContain(userA);
    expect(providerState).not.toContain(subjectA);
    expect(verifyOAuthPendingState({
      provider: "spotify",
      subject: subjectA,
      secret,
      providerState,
      sealedState,
      nowMs: nowMs + (OAUTH_STATE_TTL_SECONDS - 1) * 1_000,
    })).toBe(true);
    expect(verifyOAuthPendingState({
      provider: "spotify",
      subject: subjectB,
      secret,
      providerState,
      sealedState,
      nowMs,
    })).toBe(false);
    expect(verifyOAuthPendingState({
      provider: "strava",
      subject: subjectA,
      secret,
      providerState,
      sealedState,
      nowMs,
    })).toBe(false);
    expect(verifyOAuthPendingState({
      provider: "spotify",
      subject: subjectA,
      secret,
      providerState,
      sealedState: `${sealedState.slice(0, -1)}x`,
      nowMs,
    })).toBe(false);
    expect(verifyOAuthPendingState({
      provider: "spotify",
      subject: subjectA,
      secret,
      providerState: "m".repeat(43),
      sealedState,
      nowMs,
    })).toBe(false);
    expect(verifyOAuthPendingState({
      provider: "spotify",
      subject: subjectA,
      secret,
      providerState,
      sealedState,
      nowMs: nowMs + OAUTH_STATE_TTL_SECONDS * 1_000,
    })).toBe(false);
    expect(oauthPendingStateBelongsToSubject({
      provider: "spotify",
      subject: subjectA,
      secret,
      sealedState,
      nowMs,
    })).toBe(true);
    expect(oauthPendingStateBelongsToSubject({
      provider: "spotify",
      subject: subjectB,
      secret,
      sealedState,
      nowMs,
    })).toBe(false);
  });

  it("clears pending OAuth state only when its signed subject matches", () => {
    const store = new MemoryCookieStore();
    const pendingB = createOAuthPendingState({
      provider: "spotify",
      subject: subjectB,
      secret,
    }).sealedState;
    store.values.set("spotify_oauth_state", pendingB);

    clearProviderTokenCookiesForSubject(store, "spotify", subjectA, secret);
    expect(store.values.get("spotify_oauth_state")).toBe(pendingB);

    clearProviderTokenCookiesForSubject(store, "spotify", subjectB, secret);
    expect(store.values.has("spotify_oauth_state")).toBe(false);
  });

  it("keeps pending OAuth response mutations in disjoint attempt slots", () => {
    const browser = new MemoryCookieStore();
    const first = createOAuthPendingState({
      provider: "spotify",
      subject: subjectB,
      secret,
      nonce: "a".repeat(43),
    });
    setOAuthPendingStateCookie(
      browser,
      "spotify",
      first.sealedState,
      OAUTH_STATE_TTL_SECONDS,
      first.providerState,
    );
    const firstName = browser.operations[0]!.slice("set:".length);

    const firstCallback = new MemoryCookieStore();
    for (const [name, value] of browser.values) firstCallback.values.set(name, value);
    const second = createOAuthPendingState({
      provider: "spotify",
      subject: subjectB,
      secret,
      nonce: "b".repeat(43),
    });
    setOAuthPendingStateCookie(
      browser,
      "spotify",
      second.sealedState,
      OAUTH_STATE_TTL_SECONDS,
      second.providerState,
    );
    const secondName = browser.operations.at(-1)!.slice("set:".length);
    expect(secondName).not.toBe(firstName);

    expect(consumeOAuthPendingStateCookieForAttempt(
      firstCallback,
      "spotify",
      first.providerState,
    )).toBe(first.sealedState);
    for (const operation of firstCallback.operations) {
      if (operation.startsWith("delete:")) {
        browser.values.delete(operation.slice("delete:".length));
      }
    }
    expect(browser.values.get(secondName)).toBe(second.sealedState);
    expect(browser.values.has(firstName)).toBe(false);

    const refreshRequestA = new MemoryCookieStore();
    clearProviderCredentialCookiesForSubject(
      refreshRequestA,
      "spotify",
      subjectA,
      secret,
    );
    expect(refreshRequestA.operations).not.toContainEqual(
      expect.stringContaining("oauth_state"),
    );
    expect(consumeOAuthPendingStateCookieForAttempt(
      browser,
      "spotify",
      second.providerState,
    )).toBe(second.sealedState);
  });

  it("keeps a newer same-subject attempt across a late disconnect response", () => {
    const browser = new MemoryCookieStore();
    const first = createOAuthPendingState({
      provider: "strava",
      subject: subjectA,
      secret,
      nonce: "c".repeat(43),
    });
    setOAuthPendingStateCookie(
      browser,
      "strava",
      first.sealedState,
      OAUTH_STATE_TTL_SECONDS,
      first.providerState,
    );
    const disconnectRequest = new MemoryCookieStore();
    for (const [name, value] of browser.values) {
      disconnectRequest.values.set(name, value);
    }

    const second = createOAuthPendingState({
      provider: "strava",
      subject: subjectA,
      secret,
      nonce: "d".repeat(43),
    });
    setOAuthPendingStateCookie(
      browser,
      "strava",
      second.sealedState,
      OAUTH_STATE_TTL_SECONDS,
      second.providerState,
    );
    const secondName = browser.operations.at(-1)!.slice("set:".length);

    clearProviderTokenCookiesForSubject(
      disconnectRequest,
      "strava",
      subjectA,
      secret,
    );
    for (const operation of disconnectRequest.operations) {
      if (operation.startsWith("delete:")) {
        browser.values.delete(operation.slice("delete:".length));
      }
    }
    expect(browser.values.get(secondName)).toBe(second.sealedState);
  });

  it("selects the newest signed initiation when callbacks publish in reverse order", () => {
    const store = new MemoryCookieStore();
    const older = createOAuthPendingState({
      provider: "spotify",
      subject: subjectA,
      secret,
      nonce: "e".repeat(43),
      nowMs: nowMs,
    });
    const newer = createOAuthPendingState({
      provider: "spotify",
      subject: subjectA,
      secret,
      nonce: "f".repeat(43),
      nowMs: nowMs + 1,
    });

    replaceProviderTokenCookiesForAttempt(
      store,
      "spotify",
      { accessToken: "new-access", refreshToken: "new-refresh" },
      subjectA,
      secret,
      { providerState: newer.providerState, initiatedAtMs: nowMs + 1 },
    );
    replaceProviderTokenCookiesForAttempt(
      store,
      "spotify",
      { accessToken: "old-access", refreshToken: "old-refresh" },
      subjectA,
      secret,
      { providerState: older.providerState, initiatedAtMs: nowMs },
    );

    expect(providerTokensForSubject(store, "spotify", subjectA, secret)).toEqual({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      credentialAttempt: {
        providerState: newer.providerState,
        initiatedAtMs: nowMs + 1,
      },
    });
    expect(store.operations).toContain(
      `delete:spotify_access_token_a1_${older.providerState}`,
    );
  });

  it("fails closed when two successful attempts have the same initiation millisecond", () => {
    const store = new MemoryCookieStore();
    for (const [providerState, accessToken] of [
      ["h".repeat(43), "first-access"],
      ["i".repeat(43), "second-access"],
    ] as const) {
      replaceProviderTokenCookiesForAttempt(
        store,
        "spotify",
        { accessToken },
        subjectA,
        secret,
        { providerState, initiatedAtMs: nowMs },
      );
    }

    expect(providerTokensForSubject(store, "spotify", subjectA, secret)).toMatchObject({
      accessToken: null,
      refreshToken: null,
    });
  });

  it("does not resurrect pre-disconnect callback or refresh credentials", () => {
    const store = new MemoryCookieStore();
    const oldAttempt = {
      providerState: "j".repeat(43),
      initiatedAtMs: nowMs,
    };
    const clock = vi.spyOn(Date, "now").mockReturnValue(nowMs + 10);
    try {
      clearProviderTokenCookiesForSubject(
        store,
        "spotify",
        subjectA,
        secret,
      );
    } finally {
      clock.mockRestore();
    }

    replaceProviderTokenCookiesForAttempt(
      store,
      "spotify",
      { accessToken: "late-callback", refreshToken: "late-refresh" },
      subjectA,
      secret,
      oldAttempt,
    );
    replaceRefreshedProviderTokenCookies(
      store,
      "spotify",
      { accessToken: "later-refresh", refreshToken: "late-refresh" },
      subjectA,
      secret,
      oldAttempt,
    );
    expect(providerTokensForSubject(store, "spotify", subjectA, secret)).toEqual({
      accessToken: null,
      refreshToken: null,
    });

    const newAttempt = {
      providerState: "k".repeat(43),
      initiatedAtMs: nowMs + 11,
    };
    replaceProviderTokenCookiesForAttempt(
      store,
      "spotify",
      { accessToken: "post-disconnect", refreshToken: "post-refresh" },
      subjectA,
      secret,
      newAttempt,
    );
    expect(providerTokensForSubject(store, "spotify", subjectA, secret)).toMatchObject({
      accessToken: "post-disconnect",
      refreshToken: "post-refresh",
      credentialAttempt: newAttempt,
    });
  });

  it("selects the newest signed cutoff when disconnect responses arrive out of order", () => {
    const store = new MemoryCookieStore();
    const clock = vi.spyOn(Date, "now");
    try {
      clock.mockReturnValue(nowMs + 20);
      clearProviderTokenCookiesForSubject(store, "strava", subjectA, secret);
      clock.mockReturnValue(nowMs + 10);
      clearProviderTokenCookiesForSubject(store, "strava", subjectA, secret);
    } finally {
      clock.mockRestore();
    }
    replaceProviderTokenCookiesForAttempt(
      store,
      "strava",
      { accessToken: "between-disconnects" },
      subjectA,
      secret,
      { providerState: "l".repeat(43), initiatedAtMs: nowMs + 15 },
    );

    expect(providerTokensForSubject(store, "strava", subjectA, secret)).toEqual({
      accessToken: null,
      refreshToken: null,
    });
  });

  it("never exposes one subject's provider tokens to another subject", () => {
    const store = new MemoryCookieStore();
    store.values.set("spotify_token_owner", createProviderOwnerSeal("spotify", subjectB, secret));
    store.values.set("spotify_access_token", "stale-access");
    store.values.set("spotify_refresh_token", "stale-refresh");

    expect(providerTokensForSubject(store, "spotify", subjectA, secret)).toEqual({
      accessToken: null,
      refreshToken: null,
    });
    expect(store.values.get("spotify_access_token")).toBe("stale-access");

    replaceProviderTokenCookies(store, "spotify", {
      accessToken: "fresh-access",
      refreshToken: "fresh-refresh",
      expiresIn: 900,
    }, subjectA, secret);

    expect(providerTokensForSubject(store, "spotify", subjectA, secret)).toEqual({
      accessToken: "fresh-access",
      refreshToken: "fresh-refresh",
    });
    expect(store.operations.at(-1)).toBe("set:spotify_token_owner");
    expect(store.values.get("spotify_token_owner")).toBe(
      createProviderOwnerSeal("spotify", subjectA, secret),
    );
    expect(store.values.get("spotify_token_owner")).not.toContain(subjectA);
  });

  it("rejects tampered, cross-provider, and legacy owner cookies without deleting another subject's tuple", () => {
    expect(createProviderOwnerSeal("spotify", subjectA, secret)).toBe(
      "po1_biO-AGpq2_V9f9hbp6n-GejkA0bARQOlpbEyePn25po",
    );
    expect(createProviderOwnerSeal("strava", subjectA, secret)).toBe(
      "po1_eyn-Y2YcbK_POoshIa2Ib4_rNNlwAKLxX56PJLh2ZmY",
    );
    const invalidOwners = [
      `${createProviderOwnerSeal("spotify", subjectA, secret).slice(0, -1)}x`,
      createProviderOwnerSeal("strava", subjectA, secret),
      subjectA,
    ];

    for (const owner of invalidOwners) {
      const store = new MemoryCookieStore();
      store.values.set("spotify_token_owner", owner);
      store.values.set("spotify_access_token", "access");
      store.values.set("spotify_refresh_token", "refresh");
      expect(providerTokensForSubject(store, "spotify", subjectA, secret)).toEqual({
        accessToken: null,
        refreshToken: null,
      });
      expect(store.values.get("spotify_access_token")).toBe("access");
      expect(store.values.get("spotify_refresh_token")).toBe("refresh");
    }
  });

  it("terminally consumes callback nonces", () => {
    const store = new MemoryCookieStore();
    store.values.set("strava_oauth_state", "sealed.pending.state");

    expect(consumeOAuthPendingStateCookie(store, "strava")).toBe("sealed.pending.state");
    expect(consumeOAuthPendingStateCookie(store, "strava")).toBeNull();
    expect(store.operations).toEqual([
      "delete:strava_oauth_state",
      "delete:strava_oauth_state",
    ]);
  });
});
