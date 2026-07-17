import type { Json } from "@/lib/supabase/database.types";
import { compareVectorText } from "@/lib/vector/checksum";
import { vectorJsonSchema } from "@/lib/vector/contracts";
import type { VectorSettingClock } from "@/lib/vector/persistence-types";
import type {
  VectorSaveMigrator,
  VectorSerializedSave,
} from "@/lib/vector/types";

export function mergeVectorBestScore(current: number | null, incoming: number): number {
  return current === null ? incoming : Math.max(current, incoming);
}

export function mergeVectorStringSet(
  current: readonly string[],
  incoming: readonly string[],
): string[] {
  return [...new Set([...current, ...incoming])].sort(compareVectorText);
}

export function mergeVectorMonotonicCounters(
  current: Readonly<Record<string, number>>,
  incoming: Readonly<Record<string, number>>,
): Record<string, number> {
  const merged: Record<string, number> = { ...current };
  for (const [key, value] of Object.entries(incoming)) {
    if (!Number.isSafeInteger(value) || value < 0) continue;
    merged[key] = Math.max(merged[key] ?? 0, value);
  }
  return merged;
}

function parsePreciseClock(value: string): { wholeSecond: number; fraction: string } | null {
  const match = value.match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/i,
  );
  if (!match) return null;
  const wholeSecond = Date.parse(`${match[1]}${match[3]}`);
  if (!Number.isFinite(wholeSecond)) return null;
  return { wholeSecond, fraction: (match[2] ?? "").replace(/0+$/, "") };
}

function comparePreciseClocks(left: string, right: string): number | null {
  const leftClock = parsePreciseClock(left);
  const rightClock = parsePreciseClock(right);
  if (!leftClock || !rightClock) return null;
  if (leftClock.wholeSecond !== rightClock.wholeSecond) {
    return leftClock.wholeSecond < rightClock.wholeSecond ? -1 : 1;
  }
  const width = Math.max(leftClock.fraction.length, rightClock.fraction.length);
  const leftFraction = leftClock.fraction.padEnd(width, "0");
  const rightFraction = rightClock.fraction.padEnd(width, "0");
  return compareVectorText(leftFraction, rightFraction);
}

export function compareVectorSettingClocks(
  left: VectorSettingClock,
  right: VectorSettingClock,
): number | null {
  const timeComparison = comparePreciseClocks(left.at, right.at);
  if (timeComparison === null || timeComparison !== 0) return timeComparison;
  return compareVectorText(left.deviceId, right.deviceId);
}

function clockWins(incoming: VectorSettingClock, current: VectorSettingClock | undefined): boolean {
  if (!current) return true;
  const comparison = compareVectorSettingClocks(incoming, current);
  if (comparison === null) {
    if (!parsePreciseClock(incoming.at)) return false;
    return true;
  }
  return comparison > 0;
}

export function mergeVectorSettings(input: {
  currentValues: Readonly<Record<string, Json>>;
  currentClocks: Readonly<Record<string, VectorSettingClock>>;
  incomingValues: Readonly<Record<string, Json>>;
  incomingClocks: Readonly<Record<string, VectorSettingClock>>;
}): {
  values: Record<string, Json>;
  clocks: Record<string, VectorSettingClock>;
} {
  const values = { ...input.currentValues };
  const clocks = { ...input.currentClocks };
  for (const [key, value] of Object.entries(input.incomingValues)) {
    const incomingClock = input.incomingClocks[key];
    if (incomingClock && clockWins(incomingClock, clocks[key])) {
      values[key] = value;
      clocks[key] = incomingClock;
    }
  }
  return { values, clocks };
}

export type VectorCampaignRevision = {
  localRevision: number;
  serverRevision: number;
  expectedServerRevision: number;
  checksum: string;
};

export function mergeVectorCampaignRevision(
  local: VectorCampaignRevision,
  remote: VectorCampaignRevision | null,
): "use-local" | "equal" | "conflict" {
  if (!remote) return local.expectedServerRevision === 0 ? "use-local" : "conflict";
  if (local.checksum === remote.checksum) return "equal";
  if (local.expectedServerRevision === remote.serverRevision) return "use-local";
  return "conflict";
}

export type VectorSaveMigrationResult =
  | { ok: true; state: Json; schemaVersion: number }
  | {
      ok: false;
      code: "SAVE_SCHEMA_NEWER" | "SAVE_MIGRATOR_MISSING" | "SAVE_MIGRATION_FAILED";
      original: Json;
      schemaVersion: number;
    };

export function migrateVectorSave(
  state: Json,
  fromVersion: number,
  targetVersion: number,
  migrators: readonly VectorSaveMigrator[],
): VectorSaveMigrationResult {
  if (fromVersion > targetVersion) {
    return { ok: false, code: "SAVE_SCHEMA_NEWER", original: state, schemaVersion: fromVersion };
  }
  let current = state;
  let version = fromVersion;
  while (version < targetVersion) {
    const migrator = migrators.find((candidate) => candidate.from === version && candidate.to === version + 1);
    if (!migrator) {
      return { ok: false, code: "SAVE_MIGRATOR_MISSING", original: state, schemaVersion: version };
    }
    try {
      const migrated = migrator.migrate(current);
      const parsed = vectorJsonSchema.safeParse(migrated);
      if (!parsed.success) {
        return {
          ok: false,
          code: "SAVE_MIGRATION_FAILED",
          original: state,
          schemaVersion: version,
        };
      }
      current = parsed.data;
      version = migrator.to;
    } catch {
      return { ok: false, code: "SAVE_MIGRATION_FAILED", original: state, schemaVersion: version };
    }
  }
  return { ok: true, state: current, schemaVersion: version };
}

export type VectorRuntimeSavePreparation =
  | {
      ok: true;
      save: VectorSerializedSave | null;
      migrated: boolean;
    }
  | {
      ok: false;
      code: Extract<VectorSaveMigrationResult, { ok: false }>["code"];
    };

export function prepareVectorRuntimeSave(
  save: VectorSerializedSave | null,
  targetVersion: number,
  migrators: readonly VectorSaveMigrator[],
): VectorRuntimeSavePreparation {
  if (!save) return { ok: true, save: null, migrated: false };
  const parsed = vectorJsonSchema.safeParse(save.data);
  if (!parsed.success) return { ok: false, code: "SAVE_MIGRATION_FAILED" };
  const migration = migrateVectorSave(
    parsed.data,
    save.schemaVersion,
    targetVersion,
    migrators,
  );
  if (!migration.ok) return { ok: false, code: migration.code };
  if (migration.schemaVersion === save.schemaVersion) {
    return {
      ok: true,
      save: {
        ...save,
        data: parsed.data,
      },
      migrated: false,
    };
  }
  return {
    ok: true,
    save: {
      schemaVersion: migration.schemaVersion,
      data: migration.state,
      ...(save.seed !== undefined ? { seed: save.seed } : {}),
    },
    migrated: true,
  };
}
