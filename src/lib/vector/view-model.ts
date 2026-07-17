import { VECTOR_GAME_REGISTRY } from "@/lib/vector/registry";
import { compareVectorText } from "@/lib/vector/checksum";
import type {
  VectorLocalConflict,
  VectorLocalInstall,
  VectorLocalOutboxEvent,
  VectorLocalProfile,
  VectorLocalSave,
} from "@/lib/vector/persistence-types";
import {
  DEFAULT_VECTOR_RUNTIME_SETTINGS,
  type VectorGamePersistenceSummary,
  type VectorRuntimeSettings,
  type VectorSyncState,
} from "@/lib/vector/types";

const SYNC_PRIORITY: Record<VectorSyncState, number> = {
  conflict: 6,
  error: 5,
  syncing: 4,
  pending: 3,
  "local-only": 2,
  synced: 1,
};

function strongestSyncState(states: readonly VectorSyncState[]): VectorSyncState {
  return states.reduce<VectorSyncState>(
    (strongest, state) => SYNC_PRIORITY[state] > SYNC_PRIORITY[strongest] ? state : strongest,
    "synced",
  );
}

export function canResumeVectorSave(input: {
  gameAvailable: boolean;
  syncState: VectorSyncState;
  conflictCount: number;
}): boolean {
  return input.gameAvailable
    && input.syncState !== "conflict"
    && input.conflictCount === 0;
}

export function selectVectorHydratableSave(input: {
  gameId: VectorLocalSave["gameId"];
  preferredSlotId?: string;
  saves: readonly VectorLocalSave[];
  conflicts: readonly VectorLocalConflict[];
}): VectorLocalSave | null {
  if (input.conflicts.some((conflict) => (
    conflict.gameId === input.gameId && conflict.status === "open"
  ))) {
    return null;
  }
  return input.saves.find((save) => (
    save.gameId === input.gameId
    && save.syncState !== "conflict"
    && (!input.preferredSlotId || save.slotId === input.preferredSlotId)
  )) ?? null;
}

export function vectorRuntimeSettingsFromProfile(
  profile: VectorLocalProfile | null,
): VectorRuntimeSettings {
  const settings = profile?.settings ?? {};
  const motionPreference = settings.motionPreference;
  const volume = settings.volume;
  return {
    motionPreference:
      motionPreference === "system" ||
      motionPreference === "standard" ||
      motionPreference === "reduced"
        ? motionPreference
        : DEFAULT_VECTOR_RUNTIME_SETTINGS.motionPreference,
    resolvedMotion: DEFAULT_VECTOR_RUNTIME_SETTINGS.resolvedMotion,
    muted: typeof settings.muted === "boolean"
      ? settings.muted
      : DEFAULT_VECTOR_RUNTIME_SETTINGS.muted,
    volume: typeof volume === "number" && Number.isFinite(volume)
      ? Math.min(1, Math.max(0, volume))
      : DEFAULT_VECTOR_RUNTIME_SETTINGS.volume,
    lowPower: typeof settings.lowPower === "boolean"
      ? settings.lowPower
      : DEFAULT_VECTOR_RUNTIME_SETTINGS.lowPower,
  };
}

export function buildVectorPersistenceSummaries(input: {
  ownerScope: "account" | "anonymous";
  saves: readonly VectorLocalSave[];
  outbox: readonly VectorLocalOutboxEvent[];
  conflicts: readonly VectorLocalConflict[];
  installs: readonly VectorLocalInstall[];
}): VectorGamePersistenceSummary[] {
  const summaries: VectorGamePersistenceSummary[] = [];
  for (const game of VECTOR_GAME_REGISTRY) {
    const saves = input.saves
      .filter((save) => save.gameId === game.id)
      .sort((left, right) => (
        compareVectorText(right.updatedAt, left.updatedAt)
        || compareVectorText(left.slotId, right.slotId)
      ));
    const outbox = input.outbox.filter((event) => event.gameId === game.id);
    const conflicts = input.conflicts.filter(
      (conflict) => conflict.gameId === game.id && conflict.status === "open",
    ).sort((left, right) => (
      compareVectorText(left.createdAt, right.createdAt)
      || compareVectorText(left.id, right.id)
    ));
    const install = input.installs.find((candidate) => candidate.gameId === game.id);
    if (saves.length === 0 && outbox.length === 0 && conflicts.length === 0 && !install) continue;

    const syncStates: VectorSyncState[] = [
      ...saves.map((save) => save.syncState),
      ...outbox.map((event): VectorSyncState => {
        if (event.status === "sending") return "syncing";
        if (event.status === "error") return "error";
        return input.ownerScope === "account" ? "pending" : "local-only";
      }),
    ];
    if (conflicts.length > 0) syncStates.push("conflict");
    if (syncStates.length === 0) {
      syncStates.push(input.ownerScope === "account" ? "synced" : "local-only");
    }

    summaries.push({
      gameId: game.id,
      saves: saves.map((save) => {
        const conflictCount = conflicts.filter(
          (conflict) => conflict.slotId === save.slotId,
        ).length;
        return {
          gameId: save.gameId,
          slotId: save.slotId,
          gameVersion: save.gameVersion,
          saveSchemaVersion: save.saveSchemaVersion,
          localRevision: save.localRevision,
          serverRevision: save.serverRevision,
          updatedAt: save.updatedAt,
          syncState: save.syncState,
          conflictCount,
          canResume: canResumeVectorSave({
            gameAvailable: game.status === "available",
            syncState: save.syncState,
            conflictCount,
          }),
          ...(save.checkpointLabel ? { checkpointLabel: save.checkpointLabel } : {}),
        };
      }),
      ...(saves[0] ? { preferredSlotId: saves[0].slotId } : {}),
      conflictCount: conflicts.length,
      ...(conflicts[0] ? { preferredConflictSlotId: conflicts[0].slotId } : {}),
      pendingEventCount: outbox.filter((event) => event.status !== "frozen").length,
      syncState: strongestSyncState(syncStates),
      install: install ? {
        gameId: game.id,
        state: install.validationState === "installed" ? "installed" : "error",
        estimatedBytes: game.offline.estimatedBytes,
        installedBytes: install.installedBytes,
        buildId: install.buildId,
        ...(install.validationState === "error" ? { errorCode: "VECTOR_INSTALL_INVALID" } : {}),
      } : {
        gameId: game.id,
        state: "not-installed",
        estimatedBytes: game.offline.estimatedBytes,
        installedBytes: 0,
      },
    });
  }
  return summaries;
}
