import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { profileSubjectForUserId } from "@/lib/auth/profileSubject.server";
import {
  providerTokensForSubject,
  providerRefreshGenerationForSubject,
  providerRefreshRejectedForSubject,
  markProviderRefreshRejectedForSubject,
  clearProviderTokenCookiesForSubject,
  replaceProviderTokenCookies,
  replaceProviderTokenCookiesForAttempt,
  type MutableProviderCookieStore,
} from "@/lib/auth/providerCookies.server";
import {
  directProviderCookieKeyring,
  type DirectProviderCookieKeyring,
} from "@/lib/auth/directProviderKeyring.server";
import {
  withDirectProviderRefreshLease,
} from "@/lib/auth/directProviderRefresh.server";

function cookieStore(): MutableProviderCookieStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    get(name) {
      const value = values.get(name);
      return value === undefined ? undefined : { value };
    },
    getAll() {
      return [...values].map(([name, value]) => ({ name, value }));
    },
    set(name, value) {
      values.set(name, value);
    },
    delete(name) {
      values.delete(name);
    },
  };
}

describe("AUTH-006 late hosted-review containment", () => {
  const subject = profileSubjectForUserId("late-review-user");

  beforeEach(() => {
    process.env.DIRECT_PROVIDER_COOKIE_SECRET =
      "axis-test-direct-provider-cookie-secret-v2";
    process.env.DIRECT_PROVIDER_COOKIE_V1_ACCEPT_UNTIL =
      "2099-01-01T00:00:00.000Z";
  });

  afterEach(() => {
    delete process.env.DIRECT_PROVIDER_COOKIE_SECRET;
    delete process.env.DIRECT_PROVIDER_COOKIE_V1_ACCEPT_UNTIL;
  });

  it("permits exactly one exchange for concurrent copies of a refresh generation", async () => {
    let exchanges = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const options = {
      provider: "strava" as const,
      subject,
      refreshToken: "same-refresh-token",
      refreshGeneration: "rg2_same-signed-generation",
      providerState: "a".repeat(43),
    };
    const winner = withDirectProviderRefreshLease(options, async () => {
      exchanges += 1;
      await gate;
      return "winner";
    });
    await Promise.resolve();
    const loser = withDirectProviderRefreshLease(options, async () => {
      exchanges += 1;
      return "loser";
    });
    await expect(loser).rejects.toMatchObject({
      status: 409,
      code: "PROVIDER_REFRESH_IN_PROGRESS",
    });
    release();
    await expect(winner).resolves.toBe("winner");
    await expect(withDirectProviderRefreshLease(options, async () => "late"))
      .rejects.toMatchObject({ status: 409, code: "PROVIDER_REFRESH_IN_PROGRESS" });
    expect(exchanges).toBe(1);
  });

  it("dual-reads provider-secret v1 cookies, writes v2, and survives provider-secret rotation", () => {
    const store = cookieStore();
    replaceProviderTokenCookies(store, "spotify", {
      accessToken: "legacy-access",
      refreshToken: "legacy-refresh",
    }, subject, "old-provider-secret");
    const migrationKeyring: DirectProviderCookieKeyring = {
      current: { version: 2, secret: "stable-axis-cookie-key" },
      legacy: [{ version: 1, secret: "old-provider-secret" }],
    };
    expect(providerTokensForSubject(
      store,
      "spotify",
      subject,
      migrationKeyring,
    )).toEqual({ accessToken: "legacy-access", refreshToken: "legacy-refresh" });
    expect([...store.values.keys()].some((name) => name.includes("_s2_"))).toBe(true);
    expect([...store.values.keys()].some((name) => name.includes("_s1_"))).toBe(false);

    const rotatedProviderKeyring: DirectProviderCookieKeyring = {
      current: { version: 2, secret: "stable-axis-cookie-key" },
      legacy: [{ version: 1, secret: "new-provider-secret" }],
    };
    expect(providerTokensForSubject(
      store,
      "spotify",
      subject,
      rotatedProviderKeyring,
    )).toEqual({ accessToken: "legacy-access", refreshToken: "legacy-refresh" });
  });

  it("migrates attempt credentials to v2 and resolves equal orders by signed state", () => {
    const store = cookieStore();
    const lower = { providerState: "a".repeat(43), authorizationOrder: 200 };
    const upper = { providerState: "b".repeat(43), authorizationOrder: 200 };
    replaceProviderTokenCookiesForAttempt(store, "strava", {
      accessToken: "lower-access",
      refreshToken: "lower-refresh",
    }, subject, "old-provider-secret", lower);
    replaceProviderTokenCookiesForAttempt(store, "strava", {
      accessToken: "upper-access",
      refreshToken: "upper-refresh",
    }, subject, "old-provider-secret", upper);
    const keyring: DirectProviderCookieKeyring = {
      current: { version: 2, secret: "stable-axis-cookie-key" },
      legacy: [{ version: 1, secret: "old-provider-secret" }],
    };
    expect(providerTokensForSubject(store, "strava", subject, keyring)).toMatchObject({
      accessToken: "upper-access",
      refreshToken: "upper-refresh",
      credentialAttempt: upper,
    });
    expect(store.values.get(`strava_token_owner_a1_${upper.providerState}`))
      .toMatch(/^pa2_/);
    expect(store.values.has(`strava_token_owner_a1_${lower.providerState}`)).toBe(false);
  });

  it("re-signs previous-v2 attempt credentials, generations, rejections, and cutoffs", () => {
    const store = cookieStore();
    const attempt = { providerState: "c".repeat(43), authorizationOrder: 300 };
    const oldKeyring: DirectProviderCookieKeyring = {
      current: { version: 2, secret: "axis-key-old" },
      legacy: [],
    };
    replaceProviderTokenCookiesForAttempt(store, "strava", {
      accessToken: "old-v2-access",
      refreshToken: "old-v2-refresh",
    }, subject, oldKeyring, attempt);
    const oldOwnerName = `strava_token_owner_a1_${attempt.providerState}`;
    const oldOwner = store.values.get(oldOwnerName);
    const oldGeneration = providerRefreshGenerationForSubject(
      store,
      "strava",
      subject,
      oldKeyring,
      attempt,
    );
    markProviderRefreshRejectedForSubject(
      store,
      "strava",
      subject,
      oldKeyring,
      "old-v2-refresh",
      oldGeneration,
      attempt,
    );

    const rotatingKeyring: DirectProviderCookieKeyring = {
      current: { version: 2, secret: "axis-key-new" },
      legacy: [{ version: 2, secret: "axis-key-old" }],
    };
    expect(providerRefreshRejectedForSubject(
      store,
      "strava",
      subject,
      rotatingKeyring,
      "old-v2-refresh",
      oldGeneration,
      attempt,
    )).toBe(true);
    const currentOnly: DirectProviderCookieKeyring = {
      current: { version: 2, secret: "axis-key-new" },
      legacy: [],
    };
    expect(providerRefreshRejectedForSubject(
      store,
      "strava",
      subject,
      currentOnly,
      "old-v2-refresh",
      oldGeneration,
      attempt,
    )).toBe(true);
    expect(providerTokensForSubject(store, "strava", subject, rotatingKeyring))
      .toMatchObject({
        accessToken: "old-v2-access",
        refreshToken: "old-v2-refresh",
        credentialAttempt: attempt,
      });
    expect(store.values.get(oldOwnerName)).not.toBe(oldOwner);

    const newGeneration = providerRefreshGenerationForSubject(
      store,
      "strava",
      subject,
      currentOnly,
      attempt,
    );
    expect(newGeneration).not.toBe("legacy");
    expect(providerTokensForSubject(store, "strava", subject, currentOnly))
      .toMatchObject({ accessToken: "old-v2-access", refreshToken: "old-v2-refresh" });

    clearProviderTokenCookiesForSubject(store, "strava", subject, oldKeyring);
    expect(providerTokensForSubject(store, "strava", subject, rotatingKeyring))
      .toEqual({ accessToken: null, refreshToken: null });
    expect(providerTokensForSubject(store, "strava", subject, currentOnly))
      .toEqual({ accessToken: null, refreshToken: null });
  });

  it("retires provider-secret v1 verification at an explicit deadline", () => {
    const prior = process.env.DIRECT_PROVIDER_COOKIE_V1_ACCEPT_UNTIL;
    try {
      process.env.DIRECT_PROVIDER_COOKIE_V1_ACCEPT_UNTIL = "2000-01-01T00:00:00.000Z";
      expect(directProviderCookieKeyring("captured-provider-secret").legacy)
        .not.toContainEqual({ version: 1, secret: "captured-provider-secret" });
      process.env.DIRECT_PROVIDER_COOKIE_V1_ACCEPT_UNTIL = "not-a-date";
      expect(() => directProviderCookieKeyring("provider-secret"))
        .toThrow("DIRECT_PROVIDER_COOKIE_V1_ACCEPT_UNTIL_INVALID");
    } finally {
      if (prior === undefined) delete process.env.DIRECT_PROVIDER_COOKIE_V1_ACCEPT_UNTIL;
      else process.env.DIRECT_PROVIDER_COOKIE_V1_ACCEPT_UNTIL = prior;
    }
  });

  it("fails closed when the stable application cookie key is absent", () => {
    const prior = process.env.DIRECT_PROVIDER_COOKIE_SECRET;
    delete process.env.DIRECT_PROVIDER_COOKIE_SECRET;
    try {
      expect(() => directProviderCookieKeyring("provider-secret"))
        .toThrow("DIRECT_PROVIDER_COOKIE_SECRET_NOT_CONFIGURED");
    } finally {
      if (prior === undefined) delete process.env.DIRECT_PROVIDER_COOKIE_SECRET;
      else process.env.DIRECT_PROVIDER_COOKIE_SECRET = prior;
    }
  });
});
