import type { ThemeMode } from "@/lib/types";
import {
  DEFAULT_INTERFACE_SETTINGS,
  normalizeAccentPreset,
  type InterfaceSettings,
} from "@/lib/theme/interface-settings";

export type PreferenceEnvelope = Record<string, unknown>;

export type ParsedPreferenceEnvelope = Readonly<{
  envelope: PreferenceEnvelope;
  theme?: ThemeMode;
  settings?: InterfaceSettings;
}>;

const INTERFACE_SETTING_KEYS = new Set<keyof InterfaceSettings>([
  "accent",
  "surfaceTone",
  "cornerRadius",
  "displayFace",
  "bodyFace",
  "labelFace",
  "subheadFace",
  "density",
  "companion",
  "presence",
  "locationServices",
  "notifEnabled",
  "notifType",
  "notifFeatures",
]);
const NOTIFICATION_FEATURE_KEYS = new Set<string>([
  "pomodoro",
  "agenda",
  "mail",
  "contacts",
  "literature",
  "markets",
  "dispatch",
]);
const SETTING_ENUMS: Partial<Record<keyof InterfaceSettings, Set<string>>> = {
  surfaceTone: new Set(["deep", "mid", "lifted"]),
  displayFace: new Set([
    "array", "tanker", "neco", "nippo", "telma", "boxing", "kola",
    "instrument", "playfair", "grotesk", "bebas", "anton", "teko",
  ]),
  bodyFace: new Set([
    "archivo", "inter", "plex", "ranade", "sora", "public-sans",
    "nunito", "montserrat", "red-hat", "firasans",
  ]),
  labelFace: new Set(["narrow", "azeret", "jetbrains", "teko"]),
  subheadFace: new Set([
    "match-display", "match-body", "sora", "ranade", "grotesk",
  ]),
  density: new Set(["cozy", "default", "compact"]),
  companion: new Set(["deck", "monolith", "nova"]),
  presence: new Set(["show", "hide"]),
  notifType: new Set(["banner", "silent", "none"]),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isThemeMode(value: unknown): value is ThemeMode {
  return (
    typeof value === "string" &&
    ["dark", "dim", "light", "slate"].includes(value)
  );
}

function hasInterfaceSetting(value: Record<string, unknown>): boolean {
  return Object.keys(value).some((key) =>
    INTERFACE_SETTING_KEYS.has(key as keyof InterfaceSettings),
  );
}

function mergeSettings(value: Record<string, unknown>): InterfaceSettings {
  const partial = value as Partial<InterfaceSettings>;
  const accent = Object.hasOwn(value, "accent")
    ? normalizeAccentPreset(value.accent) ?? DEFAULT_INTERFACE_SETTINGS.accent
    : DEFAULT_INTERFACE_SETTINGS.accent;
  return {
    ...DEFAULT_INTERFACE_SETTINGS,
    ...partial,
    accent,
    notifFeatures: {
      ...DEFAULT_INTERFACE_SETTINGS.notifFeatures,
      ...(isRecord(partial.notifFeatures) ? partial.notifFeatures : {}),
    },
  };
}

function isValidNotificationFeatures(value: unknown) {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) => NOTIFICATION_FEATURE_KEYS.has(key)) &&
    Object.values(value).every((entry) => typeof entry === "boolean")
  );
}

function isValidPartialSettings(value: Record<string, unknown>) {
  return Object.entries(value).every(([key, entry]) => {
    if (!INTERFACE_SETTING_KEYS.has(key as keyof InterfaceSettings)) {
      return false;
    }
    if (key === "cornerRadius") {
      return Number.isInteger(entry) && Number(entry) >= 0 && Number(entry) <= 16;
    }
    if (key === "accent") return normalizeAccentPreset(entry) !== null;
    if (key === "locationServices" || key === "notifEnabled") {
      return typeof entry === "boolean";
    }
    if (key === "notifFeatures") return isValidNotificationFeatures(entry);
    return (
      typeof entry === "string" &&
      SETTING_ENUMS[key as keyof InterfaceSettings]?.has(entry) === true
    );
  });
}

/** Strict trust-boundary parser for route and client preference envelopes. */
export function parsePreferenceEnvelopeStrict(
  value: unknown,
): ParsedPreferenceEnvelope | null {
  if (!isRecord(value)) return null;
  if (Object.hasOwn(value, "theme") && !isThemeMode(value.theme)) return null;
  if (Object.hasOwn(value, "settings")) {
    if (!isRecord(value.settings) || !isValidPartialSettings(value.settings)) {
      return null;
    }
  } else {
    const legacy = Object.fromEntries(
      Object.entries(value).filter(([key]) =>
        INTERFACE_SETTING_KEYS.has(key as keyof InterfaceSettings),
      ),
    );
    if (!isValidPartialSettings(legacy)) return null;
  }
  return parsePreferenceEnvelope(value);
}

export function parsePreferenceEnvelope(
  value: unknown,
): ParsedPreferenceEnvelope {
  const envelope = isRecord(value) ? { ...value } : {};
  const nestedSettings = isRecord(envelope.settings)
    ? envelope.settings
    : null;
  const legacySettings =
    !nestedSettings && hasInterfaceSetting(envelope) ? envelope : null;

  return {
    envelope,
    ...(isThemeMode(envelope.theme) ? { theme: envelope.theme } : {}),
    ...(nestedSettings || legacySettings
      ? { settings: mergeSettings(nestedSettings ?? legacySettings ?? {}) }
      : {}),
  };
}

export function buildPreferenceEnvelope(
  base: PreferenceEnvelope,
  theme: ThemeMode,
  settings: InterfaceSettings,
  timeZone: string | undefined,
): PreferenceEnvelope {
  return {
    ...base,
    theme,
    settings,
    ...(timeZone ? { timeZone } : {}),
  };
}

export function fieldWasEditedSince(
  hydrationEpoch: number,
  currentEpoch: number,
): boolean {
  return currentEpoch !== hydrationEpoch;
}

export type PreferenceAuthAction = "reset-to-local" | "reload" | "ignore";

/**
 * Decides what an auth transition means for remote preference sync.
 *
 * ThemeProvider mounts in the root layout, so on the ordinary login path it
 * mounts signed-out and the app then authenticates via a soft navigation that
 * never remounts it. Resolving auth once at mount therefore stranded every
 * post-login session in local-only mode. This maps each transition to an
 * explicit action instead.
 *
 * `settledForUserId` is `undefined` until auth has resolved at least once, which
 * is what keeps the very first event from being deduped away.
 */
export function preferenceAuthAction(
  event: string,
  nextUserId: string | null,
  settledForUserId: string | null | undefined,
): PreferenceAuthAction {
  if (event === "SIGNED_OUT" || nextUserId === null) return "reset-to-local";
  // A token refresh for the account we already loaded changes nothing about
  // which row we own, so it must not restart a load.
  if (settledForUserId === nextUserId) return "ignore";
  return "reload";
}

export type SerialExecutor = Readonly<{
  enqueue: <T>(task: () => Promise<T>) => Promise<T>;
}>;

export function createSerialExecutor(): SerialExecutor {
  let tail: Promise<void> = Promise.resolve();
  return {
    enqueue<T>(task: () => Promise<T>): Promise<T> {
      const result = tail.then(task, task);
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}
