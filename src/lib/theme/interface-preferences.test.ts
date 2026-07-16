import { describe, expect, it } from "vitest";
import { DEFAULT_INTERFACE_SETTINGS } from "@/lib/theme/interface-settings";
import {
  applyInterfaceSettingsPatch,
  canUseInterfacePreferenceCache,
  InterfacePreferenceWriteQueue,
  INTERFACE_PREFERENCES_VERSION,
  INTERFACE_PREFERENCES_VERSION_UNSUPPORTED,
  hydrateInterfacePreferenceSnapshot,
  interfacePreferenceSignature,
  mergeInterfacePreferenceEnvelope,
  normalizeInterfaceSettings,
  parseInterfacePreferences,
  shouldClaimInterfacePreferenceCache,
  shouldPersistInterfacePreferences,
  shouldResetInterfacePreferenceCache,
  updateInterfaceSettingsPatch,
} from "./interface-preferences";

describe("interface preference envelope", () => {
  it("parses legacy flat settings without treating envelope metadata as settings", () => {
    const parsed = parseInterfacePreferences({
      theme: "slate",
      accent: "marine",
      presence: "show",
      timeZone: "America/New_York",
      futureEnvelopeField: { enabled: true },
    });

    expect(parsed?.theme).toBe("slate");
    expect(parsed?.settings).toMatchObject({ accent: "marine", presence: "show" });
    expect(parsed?.timeZone).toBe("America/New_York");
    expect(parsed?.envelope.futureEnvelopeField).toEqual({ enabled: true });
    expect(parsed?.rawSettings).not.toHaveProperty("timeZone");
  });

  it("preserves unknown outer, nested, and timezone fields for the current version", () => {
    const parsed = parseInterfacePreferences({
      version: INTERFACE_PREFERENCES_VERSION,
      theme: "dark",
      timeZone: "Europe/London",
      futureEnvelopeField: { enabled: true },
      settings: {
        ...DEFAULT_INTERFACE_SETTINGS,
        futureSetting: "keep-me",
        notifFeatures: {
          ...DEFAULT_INTERFACE_SETTINGS.notifFeatures,
          futureNotification: true,
        },
      },
    });

    const merged = mergeInterfacePreferenceEnvelope(parsed, {
      theme: "light",
      settings: { ...DEFAULT_INTERFACE_SETTINGS, accent: "clay" },
    });

    expect(merged).toMatchObject({
      version: INTERFACE_PREFERENCES_VERSION,
      theme: "light",
      timeZone: "Europe/London",
      futureEnvelopeField: { enabled: true },
      settings: {
        accent: "clay",
        futureSetting: "keep-me",
        notifFeatures: { futureNotification: true },
      },
    });
  });

  it("refuses to mutate a newer incompatible envelope", () => {
    const parsed = parseInterfacePreferences({
      version: INTERFACE_PREFERENCES_VERSION + 1,
      theme: "dark",
      settings: DEFAULT_INTERFACE_SETTINGS,
      futureEnvelopeField: true,
    });

    expect(parsed?.writeCompatible).toBe(false);
    expect(() => mergeInterfacePreferenceEnvelope(parsed, {
      theme: "light",
      settings: DEFAULT_INTERFACE_SETTINGS,
    })).toThrow(INTERFACE_PREFERENCES_VERSION_UNSUPPORTED);
  });

  it("normalizes corrupt known fields while retaining safe defaults", () => {
    expect(normalizeInterfaceSettings({
      accent: "not-an-accent",
      cornerRadius: 999,
      notifEnabled: "yes",
      notifFeatures: { agenda: false, mail: "yes" },
    })).toMatchObject({
      accent: DEFAULT_INTERFACE_SETTINGS.accent,
      cornerRadius: DEFAULT_INTERFACE_SETTINGS.cornerRadius,
      notifEnabled: DEFAULT_INTERFACE_SETTINGS.notifEnabled,
      notifFeatures: {
        agenda: false,
        mail: DEFAULT_INTERFACE_SETTINGS.notifFeatures.mail,
      },
    });
  });

  it("writes a versioned envelope and carries the browser timezone", () => {
    const merged = mergeInterfacePreferenceEnvelope(null, {
      theme: "dim",
      settings: DEFAULT_INTERFACE_SETTINGS,
      timeZone: "America/Los_Angeles",
    });

    expect(merged).toMatchObject({
      version: INTERFACE_PREFERENCES_VERSION,
      theme: "dim",
      timeZone: "America/Los_Angeles",
      settings: DEFAULT_INTERFACE_SETTINGS,
    });
  });

  it("preserves the stored timezone when a stale browser snapshot differs", () => {
    const parsed = parseInterfacePreferences({
      version: INTERFACE_PREFERENCES_VERSION,
      theme: "dark",
      timeZone: "America/New_York",
      settings: DEFAULT_INTERFACE_SETTINGS,
    });
    const merged = mergeInterfacePreferenceEnvelope(parsed, {
      theme: "light",
      settings: DEFAULT_INTERFACE_SETTINGS,
      timeZone: "Europe/London",
    });

    expect(merged).toMatchObject({ timeZone: "America/New_York" });
  });

  it("rejects an invalid stored timezone so a safe browser timezone can replace it", () => {
    const parsed = parseInterfacePreferences({
      version: INTERFACE_PREFERENCES_VERSION,
      theme: "dark",
      timeZone: "not/a-timezone",
      settings: DEFAULT_INTERFACE_SETTINGS,
    });
    const merged = mergeInterfacePreferenceEnvelope(parsed, {
      theme: "dark",
      settings: DEFAULT_INTERFACE_SETTINGS,
      timeZone: "UTC",
    });

    expect(parsed?.timeZone).toBeUndefined();
    expect(parsed?.requiresRewrite).toBe(true);
    expect(merged).toMatchObject({ timeZone: "UTC" });
  });

  it("drops an invalid stored timezone when the browser cannot provide a replacement", () => {
    const parsed = parseInterfacePreferences({
      version: INTERFACE_PREFERENCES_VERSION,
      theme: "dark",
      timeZone: "not/a-timezone",
      settings: DEFAULT_INTERFACE_SETTINGS,
    });
    const merged = mergeInterfacePreferenceEnvelope(parsed, {
      theme: "dark",
      settings: DEFAULT_INTERFACE_SETTINGS,
    });

    expect(merged).not.toHaveProperty("timeZone");
  });

  it("never hydrates missing remote fields from another account's cache", () => {
    const remote = parseInterfacePreferences({
      version: INTERFACE_PREFERENCES_VERSION,
      theme: "light",
    });
    const hydrated = hydrateInterfacePreferenceSnapshot({
      remote,
      cached: {
        theme: "slate",
        settings: {
          ...DEFAULT_INTERFACE_SETTINGS,
          accent: "clay",
        },
      },
      cacheOwnedByUser: false,
      pendingSettings: { density: "compact" },
    });

    expect(hydrated).toMatchObject({
      theme: "light",
      settings: {
        accent: DEFAULT_INTERFACE_SETTINGS.accent,
        density: "compact",
      },
    });
  });

  it("applies only fields edited during hydration over the remote settings", () => {
    const remote = {
      ...DEFAULT_INTERFACE_SETTINGS,
      accent: "marine" as const,
      density: "compact" as const,
      notifFeatures: {
        ...DEFAULT_INTERFACE_SETTINGS.notifFeatures,
        agenda: false,
        mail: true,
      },
    };
    const cached = {
      ...DEFAULT_INTERFACE_SETTINGS,
      accent: "clay" as const,
      density: "cozy" as const,
      notifFeatures: {
        ...DEFAULT_INTERFACE_SETTINGS.notifFeatures,
        agenda: true,
        mail: false,
      },
    };
    const edited = {
      ...cached,
      density: "default" as const,
      notifFeatures: {
        ...cached.notifFeatures,
        agenda: false,
      },
    };
    const patch = updateInterfaceSettingsPatch({}, cached, edited);

    expect(applyInterfaceSettingsPatch(remote, patch)).toMatchObject({
      accent: "marine",
      density: "default",
      notifFeatures: {
        agenda: false,
        mail: true,
      },
    });
  });

  it("never writes after a failed read and skips identical hydration echo", () => {
    const signature = interfacePreferenceSignature({
      theme: "dark",
      settings: DEFAULT_INTERFACE_SETTINGS,
      timeZone: "UTC",
    });

    expect(shouldPersistInterfacePreferences({
      mounted: true,
      remoteReadSucceeded: false,
      loadedUserId: "user_1",
      currentUserId: "user_1",
      currentSignature: signature,
      persistedSignature: null,
    })).toBe(false);
    expect(shouldPersistInterfacePreferences({
      mounted: true,
      remoteReadSucceeded: true,
      loadedUserId: "user_1",
      currentUserId: "user_1",
      currentSignature: signature,
      persistedSignature: signature,
    })).toBe(false);
    expect(shouldPersistInterfacePreferences({
      mounted: true,
      remoteReadSucceeded: true,
      loadedUserId: "user_1",
      currentUserId: "user_1",
      currentSignature: signature,
      persistedSignature: null,
    })).toBe(true);
    expect(shouldPersistInterfacePreferences({
      mounted: true,
      remoteReadSucceeded: true,
      loadedUserId: "user_1",
      currentUserId: "user_2",
      currentSignature: signature,
      persistedSignature: null,
    })).toBe(false);
  });

  it.each([
    {
      scenario: "a different authenticated account resolves",
      cachedOwner: "user_1",
      previousUserId: undefined,
      nextUserId: "user_2",
      expected: true,
    },
    {
      scenario: "an owned cache resolves without a signed-in user",
      cachedOwner: "user_1",
      previousUserId: undefined,
      nextUserId: null,
      expected: true,
    },
    {
      scenario: "an authenticated user signs out even when storage is unavailable",
      cachedOwner: null,
      previousUserId: "user_1",
      nextUserId: null,
      expected: true,
    },
    {
      scenario: "authenticated accounts switch even when storage is unavailable",
      cachedOwner: null,
      previousUserId: "user_1",
      nextUserId: "user_2",
      expected: true,
    },
    {
      scenario: "the cache belongs to the resolved account",
      cachedOwner: "user_1",
      previousUserId: undefined,
      nextUserId: "user_1",
      expected: false,
    },
    {
      scenario: "anonymous local preferences have no owner",
      cachedOwner: null,
      previousUserId: undefined,
      nextUserId: null,
      expected: false,
    },
    {
      scenario: "anonymous local preferences carry into first sign-in",
      cachedOwner: null,
      previousUserId: null,
      nextUserId: "user_1",
      expected: false,
    },
  ])("$scenario", ({ cachedOwner, previousUserId, nextUserId, expected }) => {
    expect(shouldResetInterfacePreferenceCache({
      cachedOwner,
      previousUserId,
      nextUserId,
    })).toBe(expected);
  });

  it("uses ownerless anonymous preferences for first sign-in but rejects another account's cache", () => {
    expect(canUseInterfacePreferenceCache(null, "user_1")).toBe(true);
    expect(canUseInterfacePreferenceCache("user_1", "user_1")).toBe(true);
    expect(canUseInterfacePreferenceCache("user_2", "user_1")).toBe(false);
  });

  it("claims an ownerless cache as soon as an authenticated owner resolves", () => {
    expect(shouldClaimInterfacePreferenceCache(null, "user_1")).toBe(true);
    expect(shouldClaimInterfacePreferenceCache("user_1", "user_1")).toBe(false);
    expect(shouldClaimInterfacePreferenceCache("user_2", "user_1")).toBe(false);
    expect(shouldClaimInterfacePreferenceCache(null, null)).toBe(false);
  });

  it("serializes in-flight writes so the latest snapshot finishes last", async () => {
    const queue = new InterfacePreferenceWriteQueue();
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    let markFirstStarted: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });

    const first = queue.enqueue(async () => {
      order.push("first:start");
      markFirstStarted?.();
      await firstGate;
      order.push("first:end");
    });
    await firstStarted;
    const second = queue.enqueue(async () => {
      order.push("second");
    });
    releaseFirst?.();

    await Promise.all([first.done, second.done]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
    expect(await second.done).toBe("completed");
  });

  it("skips an obsolete queued write before it starts", async () => {
    const queue = new InterfacePreferenceWriteQueue();
    const writes: string[] = [];
    const first = queue.enqueue(async () => {
      writes.push("first");
    });
    const second = queue.enqueue(async () => {
      writes.push("second");
    });

    await Promise.all([first.done, second.done]);
    expect(await first.done).toBe("skipped");
    expect(writes).toEqual(["second"]);
  });
});
