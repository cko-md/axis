import type { ThemeMode } from "@/lib/types";
import type { Json } from "@/lib/supabase/database.types";
import {
  DEFAULT_INTERFACE_SETTINGS,
  type InterfaceSettings,
  type NotifFeatures,
} from "@/lib/theme/interface-settings";

export const INTERFACE_PREFERENCES_VERSION = 1;
export const INTERFACE_PREFERENCES_VERSION_UNSUPPORTED =
  "INTERFACE_PREFERENCES_VERSION_UNSUPPORTED";

type JsonRecord = Record<string, unknown>;

export type ParsedInterfacePreferences = {
  envelope: JsonRecord;
  rawSettings: JsonRecord;
  version: number;
  writeCompatible: boolean;
  requiresRewrite: boolean;
  theme?: ThemeMode;
  settings?: InterfaceSettings;
  timeZone?: string;
};

export type InterfacePreferenceSnapshot = {
  theme: ThemeMode;
  settings: InterfaceSettings;
  timeZone?: string;
};

export type InterfaceSettingsPatch = Partial<Omit<InterfaceSettings, "notifFeatures">> & {
  notifFeatures?: Partial<NotifFeatures>;
};

const THEME_MODES: readonly ThemeMode[] = ["dark", "dim", "light", "slate"];
const ACCENTS = ["gold", "marine", "clay", "bone", "sage", "chrome"] as const;
const SURFACE_TONES = ["deep", "mid", "lifted"] as const;
const DISPLAY_FACES = [
  "array", "tanker", "neco", "nippo", "telma", "boxing", "kola",
  "instrument", "playfair", "grotesk", "bebas", "anton", "teko",
] as const;
const BODY_FACES = [
  "archivo", "inter", "plex", "ranade", "sora", "public-sans", "nunito",
  "montserrat", "red-hat", "firasans",
] as const;
const LABEL_FACES = ["narrow", "azeret", "jetbrains", "teko"] as const;
const SUBHEAD_FACES = ["match-display", "match-body", "sora", "ranade", "grotesk"] as const;
const DENSITIES = ["cozy", "default", "compact"] as const;
const COMPANIONS = ["deck", "monolith", "nova"] as const;
const PRESENCE = ["show", "hide"] as const;
const NOTIFICATION_TYPES = ["banner", "silent", "none"] as const;
const NOTIFICATION_FEATURES = [
  "pomodoro", "agenda", "mail", "contacts", "literature", "markets", "dispatch",
] as const;
const SETTING_KEYS: readonly (keyof InterfaceSettings)[] = [
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
];
const SCALAR_SETTING_KEYS = SETTING_KEYS.filter(
  (key): key is Exclude<keyof InterfaceSettings, "notifFeatures"> => key !== "notifFeatures",
);

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === "string" && (THEME_MODES as readonly string[]).includes(value);
}

function oneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function normalizeTimeZone(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const timeZone = value.trim();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
    return timeZone;
  } catch {
    return undefined;
  }
}

export function normalizeInterfaceSettings(value: unknown): InterfaceSettings | null {
  if (!isRecord(value)) return null;
  const settings: InterfaceSettings = {
    ...DEFAULT_INTERFACE_SETTINGS,
    notifFeatures: { ...DEFAULT_INTERFACE_SETTINGS.notifFeatures },
  };

  if (oneOf(value.accent, ACCENTS)) settings.accent = value.accent;
  if (oneOf(value.surfaceTone, SURFACE_TONES)) settings.surfaceTone = value.surfaceTone;
  if (
    typeof value.cornerRadius === "number" &&
    Number.isFinite(value.cornerRadius) &&
    value.cornerRadius >= 0 &&
    value.cornerRadius <= 16
  ) {
    settings.cornerRadius = value.cornerRadius;
  }
  if (oneOf(value.displayFace, DISPLAY_FACES)) settings.displayFace = value.displayFace;
  if (oneOf(value.bodyFace, BODY_FACES)) settings.bodyFace = value.bodyFace;
  if (oneOf(value.labelFace, LABEL_FACES)) settings.labelFace = value.labelFace;
  if (oneOf(value.subheadFace, SUBHEAD_FACES)) settings.subheadFace = value.subheadFace;
  if (oneOf(value.density, DENSITIES)) settings.density = value.density;
  if (oneOf(value.companion, COMPANIONS)) settings.companion = value.companion;
  if (oneOf(value.presence, PRESENCE)) settings.presence = value.presence;
  if (typeof value.locationServices === "boolean") settings.locationServices = value.locationServices;
  if (typeof value.notifEnabled === "boolean") settings.notifEnabled = value.notifEnabled;
  if (oneOf(value.notifType, NOTIFICATION_TYPES)) settings.notifType = value.notifType;
  if (isRecord(value.notifFeatures)) {
    for (const key of NOTIFICATION_FEATURES) {
      if (typeof value.notifFeatures[key] === "boolean") {
        settings.notifFeatures[key] = value.notifFeatures[key];
      }
    }
  }

  return settings;
}

export function updateInterfaceSettingsPatch(
  patch: InterfaceSettingsPatch,
  previous: InterfaceSettings,
  next: InterfaceSettings,
): InterfaceSettingsPatch {
  const updated: InterfaceSettingsPatch = {
    ...patch,
    ...(patch.notifFeatures ? { notifFeatures: { ...patch.notifFeatures } } : {}),
  };
  const scalarPatch = updated as Record<string, unknown>;

  for (const key of SCALAR_SETTING_KEYS) {
    if (previous[key] !== next[key]) scalarPatch[key] = next[key];
  }
  for (const key of NOTIFICATION_FEATURES) {
    if (previous.notifFeatures[key] !== next.notifFeatures[key]) {
      updated.notifFeatures = {
        ...updated.notifFeatures,
        [key]: next.notifFeatures[key],
      };
    }
  }

  return updated;
}

export function applyInterfaceSettingsPatch(
  base: InterfaceSettings,
  patch: InterfaceSettingsPatch,
): InterfaceSettings {
  return {
    ...base,
    ...patch,
    notifFeatures: {
      ...base.notifFeatures,
      ...patch.notifFeatures,
    },
  };
}

export function hydrateInterfacePreferenceSnapshot(input: {
  remote: ParsedInterfacePreferences | null;
  cached: Pick<InterfacePreferenceSnapshot, "theme" | "settings">;
  cacheOwnedByUser: boolean;
  pendingTheme?: ThemeMode;
  pendingSettings: InterfaceSettingsPatch;
}): Pick<InterfacePreferenceSnapshot, "theme" | "settings"> {
  const fallbackTheme = input.cacheOwnedByUser ? input.cached.theme : "dark";
  const fallbackSettings = input.cacheOwnedByUser
    ? input.cached.settings
    : DEFAULT_INTERFACE_SETTINGS;

  return {
    theme: input.pendingTheme ?? input.remote?.theme ?? fallbackTheme,
    settings: applyInterfaceSettingsPatch(
      input.remote?.settings ?? fallbackSettings,
      input.pendingSettings,
    ),
  };
}

/**
 * Parse both the current envelope and the former flat settings shape.
 *
 * Unknown outer fields and unknown nested setting fields are retained so later
 * writers can update their known keys without erasing data owned by another
 * feature or a newer client.
 */
export function parseInterfacePreferences(value: unknown): ParsedInterfacePreferences | null {
  if (!isRecord(value) || Object.keys(value).length === 0) return null;

  const parsedVersion = typeof value.version === "number" &&
    Number.isInteger(value.version) &&
    value.version > 0
    ? value.version
    : INTERFACE_PREFERENCES_VERSION;
  const normalizedTimeZone = normalizeTimeZone(value.timeZone);
  const requiresRewrite = Object.prototype.hasOwnProperty.call(value, "timeZone") &&
    normalizedTimeZone === undefined;
  const nestedSettings = isRecord(value.settings) ? value.settings : null;
  if (nestedSettings) {
    return {
      envelope: { ...value },
      rawSettings: { ...nestedSettings },
      version: parsedVersion,
      writeCompatible: parsedVersion <= INTERFACE_PREFERENCES_VERSION,
      requiresRewrite,
      theme: isThemeMode(value.theme) ? value.theme : undefined,
      settings: normalizeInterfaceSettings(nestedSettings) ?? undefined,
      timeZone: normalizedTimeZone,
    };
  }

  const legacySettings: JsonRecord = {};
  const envelope: JsonRecord = {};
  for (const [key, entry] of Object.entries(value)) {
    if ((SETTING_KEYS as readonly string[]).includes(key)) {
      legacySettings[key] = entry;
    } else {
      envelope[key] = entry;
    }
  }

  return {
    envelope,
    rawSettings: legacySettings,
    version: parsedVersion,
    writeCompatible: parsedVersion <= INTERFACE_PREFERENCES_VERSION,
    requiresRewrite,
    theme: isThemeMode(value.theme) ? value.theme : undefined,
    settings: Object.keys(legacySettings).length > 0
      ? normalizeInterfaceSettings(legacySettings) ?? undefined
      : undefined,
    timeZone: normalizedTimeZone,
  };
}

export function mergeInterfacePreferenceEnvelope(
  base: ParsedInterfacePreferences | null,
  snapshot: InterfacePreferenceSnapshot,
): Json {
  if (base && !base.writeCompatible) {
    throw new Error(INTERFACE_PREFERENCES_VERSION_UNSUPPORTED);
  }
  const existingVersion = base?.envelope.version;
  const version = typeof existingVersion === "number" &&
    Number.isInteger(existingVersion) &&
    existingVersion >= INTERFACE_PREFERENCES_VERSION
    ? existingVersion
    : INTERFACE_PREFERENCES_VERSION;
  const storedTimeZone = base?.timeZone;
  const timeZone = storedTimeZone ?? snapshot.timeZone;
  const rawNotifFeatures = isRecord(base?.rawSettings.notifFeatures)
    ? base.rawSettings.notifFeatures
    : {};

  const merged: JsonRecord = {
    ...(base?.envelope ?? {}),
    version,
    theme: snapshot.theme,
    settings: {
      ...(base?.rawSettings ?? {}),
      ...snapshot.settings,
      notifFeatures: {
        ...rawNotifFeatures,
        ...snapshot.settings.notifFeatures,
      },
    },
  };

  if (timeZone) {
    merged.timeZone = timeZone;
  } else {
    delete merged.timeZone;
  }
  return merged as Json;
}

export function interfacePreferenceSignature(snapshot: InterfacePreferenceSnapshot): string {
  return JSON.stringify({
    theme: snapshot.theme,
    settings: snapshot.settings,
    timeZone: snapshot.timeZone ?? null,
  });
}

export function shouldPersistInterfacePreferences(input: {
  mounted: boolean;
  remoteReadSucceeded: boolean;
  loadedUserId: string | null;
  currentUserId: string | null;
  currentSignature: string;
  persistedSignature: string | null;
}): boolean {
  return input.mounted &&
    input.remoteReadSucceeded &&
    !!input.loadedUserId &&
    input.loadedUserId === input.currentUserId &&
    input.currentSignature !== input.persistedSignature;
}

export function shouldResetInterfacePreferenceCache(input: {
  cachedOwner: string | null;
  previousUserId: string | null | undefined;
  nextUserId: string | null;
}): boolean {
  const cacheBelongsToAnotherAccount =
    input.cachedOwner !== null && input.cachedOwner !== input.nextUserId;
  const authenticatedAccountChanged =
    input.previousUserId !== undefined &&
    input.previousUserId !== null &&
    input.previousUserId !== input.nextUserId;

  return cacheBelongsToAnotherAccount || authenticatedAccountChanged;
}

export function canUseInterfacePreferenceCache(
  cachedOwner: string | null,
  userId: string,
): boolean {
  return cachedOwner === null || cachedOwner === userId;
}

export function shouldClaimInterfacePreferenceCache(
  cachedOwner: string | null,
  userId: string | null,
): boolean {
  return cachedOwner === null && userId !== null;
}

export class InterfacePreferenceWriteQueue {
  private tail: Promise<void> = Promise.resolve();
  private latestRevision = 0;

  enqueue(task: () => Promise<void>): { revision: number; done: Promise<"completed" | "skipped"> } {
    const revision = ++this.latestRevision;
    const done = this.tail
      .catch(() => undefined)
      .then(async () => {
        if (revision !== this.latestRevision) return "skipped" as const;
        await task();
        return "completed" as const;
      });
    this.tail = done.then(() => undefined, () => undefined);
    return { revision, done };
  }

  isLatest(revision: number): boolean {
    return revision === this.latestRevision;
  }

  invalidate(): void {
    this.latestRevision += 1;
  }
}
