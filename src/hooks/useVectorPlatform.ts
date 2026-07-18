"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { captureRouteError } from "@/lib/observability/captureRouteError";
import { createClient } from "@/lib/supabase/client";
import type { Json } from "@/lib/supabase/database.types";
import {
  vectorJsonSchema,
  type VectorConflictResolution,
} from "@/lib/vector/contracts";
import { prepareVectorRuntimeSave } from "@/lib/vector/merge";
import {
  changeVectorRepositoryOwner,
  openVectorRepository,
  VectorPersistenceError,
  vectorAnonymousOwner,
  vectorScoreKey,
  type VectorMigrationFailureReason,
  type VectorPersistence,
  type VectorSaveAncestor,
} from "@/lib/vector/persistence";
import type {
  VectorLocalConflict,
  VectorLocalSave,
  VectorOwnerKey,
  VectorSettingClock,
} from "@/lib/vector/persistence-types";
import {
  bootstrapVectorCloud,
  resolveVectorCloudConflict,
  syncVectorGame,
  type VectorConflictResolutionOutcome,
  type VectorSyncOutcome,
} from "@/lib/vector/sync";
import {
  DEFAULT_VECTOR_RUNTIME_SETTINGS,
  VECTOR_GAME_SLUGS,
  type VectorGamePersistenceSummary,
  type VectorGameScoreInput,
  type VectorGameSlug,
  type VectorLocalDataState,
  type VectorRuntimeSettings,
  type VectorSaveMigrator,
  type VectorSaveReason,
  type VectorSerializedSave,
} from "@/lib/vector/types";
import {
  buildVectorPersistenceSummaries,
  vectorRuntimeSettingsFromProfile,
} from "@/lib/vector/view-model";

const SETTINGS_CHANNEL: VectorGameSlug = "second-sense";

type AdoptionOffer = {
  anonymousOwner: VectorOwnerKey;
  saves: number;
  events: number;
  collisions: number;
};

type PlatformView = {
  localDataState: VectorLocalDataState;
  settings: VectorRuntimeSettings;
  summaries: VectorGamePersistenceSummary[];
  saves: VectorLocalSave[];
  conflicts: VectorLocalConflict[];
  ownerScope: "account" | "anonymous" | null;
  ownerEpoch: number | null;
  adoptionOffer: AdoptionOffer | null;
  operationError: string | null;
};

const INITIAL_VIEW: PlatformView = {
  localDataState: {
    status: "loading",
    message: "Opening the owner-scoped VECTOR database.",
  },
  settings: DEFAULT_VECTOR_RUNTIME_SETTINGS,
  summaries: [],
  saves: [],
  conflicts: [],
  ownerScope: null,
  ownerEpoch: null,
  adoptionOffer: null,
  operationError: null,
};

type ConflictResolution = VectorConflictResolution["resolution"];

type ConflictRepository = Pick<
  VectorPersistence,
  | "getActiveOwner"
  | "resolveLocalConflict"
  | "applyCloudConflictResolution"
>;

type ConflictResolutionKey = {
  key: string;
  intent: string;
};

type VectorOwnerTransitionBarrier = () => void | Promise<void>;

const VECTOR_MIGRATION_FAILURE_REASONS = new Set([
  "save_schema_newer",
  "save_migrator_missing",
  "save_migration_failed",
]);

export function assertVectorOwnerEpoch(
  currentOwner: VectorOwnerKey | null,
  currentEpoch: number,
  expectedOwner: VectorOwnerKey,
  expectedEpoch: number,
) {
  if (currentOwner !== expectedOwner || currentEpoch !== expectedEpoch) {
    throw new Error("VECTOR_OWNER_CHANGED");
  }
}

export function hasUnscopedVectorQuarantine(
  unscopedQuarantined: number,
) {
  // Game/slot-scoped corruption becomes a visible conflict workflow. Only rows
  // whose identity is too malformed to assign safely require a platform-wide
  // recovery stop.
  return unscopedQuarantined > 0;
}

export function selectVectorStateBootstrapGames(input: {
  pendingGames: Iterable<VectorGameSlug>;
  remoteSaveGames: Iterable<VectorGameSlug>;
  remoteConflictGames: Iterable<VectorGameSlug>;
}): VectorGameSlug[] {
  const relevant = new Set<VectorGameSlug>([
    ...input.pendingGames,
    ...input.remoteSaveGames,
    ...input.remoteConflictGames,
  ]);
  return VECTOR_GAME_SLUGS.filter((gameId) => relevant.has(gameId));
}

export function prepareVectorMigrationRetry(
  conflict: VectorLocalConflict,
  targetSaveSchemaVersion: number,
  migrators: readonly VectorSaveMigrator[],
): VectorSerializedSave {
  if (
    conflict.authority !== "local"
    || conflict.status !== "open"
    || !VECTOR_MIGRATION_FAILURE_REASONS.has(conflict.reason)
    || conflict.local.state === undefined
  ) {
    throw new Error("VECTOR_MIGRATION_RETRY_NOT_ALLOWED");
  }
  const prepared = prepareVectorRuntimeSave({
    schemaVersion: conflict.local.saveSchemaVersion,
    data: conflict.local.state,
    checksum: conflict.local.checksum,
    ...(conflict.local.seed !== null ? { seed: conflict.local.seed } : {}),
  }, targetSaveSchemaVersion, migrators);
  if (!prepared.ok) throw new Error(`VECTOR_${prepared.code}`);
  if (!prepared.save) throw new Error("VECTOR_MIGRATION_RETRY_NOT_ALLOWED");
  return prepared.save;
}

export function getOrCreateVectorConflictResolutionKey(
  keys: Map<string, ConflictResolutionKey>,
  conflictId: string,
  resolution: ConflictResolution,
  targetSlotId: string | undefined,
  createKey: () => string = () => crypto.randomUUID(),
): string {
  const intent = JSON.stringify([resolution, targetSlotId ?? null]);
  const existing = keys.get(conflictId);
  if (existing?.intent === intent) return existing.key;
  const created = createKey();
  keys.set(conflictId, { key: created, intent });
  return created;
}

export async function publishVectorLocalState<T>(input: {
  readLocal: () => Promise<T>;
  publishLocal: (value: T) => void;
}): Promise<T> {
  const local = await input.readLocal();
  input.publishLocal(local);
  return local;
}

export async function executeVectorConflictResolution(input: {
  repository: ConflictRepository;
  ownerKey: VectorOwnerKey;
  conflict: VectorLocalConflict;
  resolution: ConflictResolution;
  targetSlotId?: string;
  idempotencyKey: string;
  resolveCloud?: typeof resolveVectorCloudConflict;
}): Promise<VectorConflictResolutionOutcome | { status: "resolved-local" }> {
  if (
    input.repository.getActiveOwner() !== input.ownerKey
    || input.conflict.ownerKey !== input.ownerKey
  ) {
    return { status: "error", code: "VECTOR_OWNER_CHANGED", retryable: false };
  }
  if (input.conflict.status !== "open") {
    return { status: "error", code: "VECTOR_CONFLICT_NOT_OPEN", retryable: false };
  }
  if (input.conflict.authority === "local") {
    await input.repository.resolveLocalConflict(
      input.ownerKey,
      input.conflict.id,
      input.resolution,
      input.targetSlotId,
    );
    return { status: "resolved-local" };
  }
  if (!input.ownerKey.startsWith("user:")) {
    return { status: "error", code: "VECTOR_CONFLICT_AUTH_REQUIRED", retryable: false };
  }
  const cloud = await (input.resolveCloud ?? resolveVectorCloudConflict)({
    conflictId: input.conflict.id,
    idempotencyKey: input.idempotencyKey,
    resolution: {
      expectedConflictVersion: input.conflict.conflictVersion,
      resolution: input.resolution,
      ...(input.targetSlotId ? { targetSlotId: input.targetSlotId } : {}),
    },
  });
  if (cloud.status === "error") return cloud;
  const expectedResultSlot = input.resolution === "fork-local"
    ? input.targetSlotId
    : input.conflict.slotId;
  const resolvedBranch = cloud.response.result.resolvedBranch;
  if (
    cloud.response.conflict.id !== input.conflict.id
    || cloud.response.conflict.gameId !== input.conflict.gameId
    || cloud.response.conflict.slotId !== input.conflict.slotId
    || cloud.response.conflict.status !== "resolved"
    || cloud.response.conflict.resolution !== input.resolution
    || cloud.response.conflict.conflictVersion <= input.conflict.conflictVersion
    || cloud.response.conflict.local.localRevision !== input.conflict.local.localRevision
    || cloud.response.conflict.local.checksum !== input.conflict.local.checksum
    || cloud.response.result.idempotencyKey !== input.idempotencyKey
    || cloud.response.result.kind !== "save"
    || !["applied", "duplicate"].includes(cloud.response.result.status)
    || cloud.response.result.code !== null
    || cloud.response.result.conflictId !== input.conflict.id
    || cloud.response.result.slotId !== expectedResultSlot
    || cloud.response.result.localRevision !== input.conflict.local.localRevision
    || !resolvedBranch
    || resolvedBranch.slotId !== expectedResultSlot
    || cloud.response.result.serverRevision !== resolvedBranch.serverRevision
  ) {
    return {
      status: "error",
      code: "VECTOR_CONFLICT_RESPONSE_MISMATCH",
      retryable: true,
    };
  }
  if (input.repository.getActiveOwner() !== input.ownerKey) {
    return { status: "error", code: "VECTOR_OWNER_CHANGED", retryable: false };
  }
  await input.repository.applyCloudConflictResolution(
    input.ownerKey,
    cloud.response.conflict,
    cloud.response.saves,
    {
      resolution: input.resolution,
      ...(input.targetSlotId ? { targetSlotId: input.targetSlotId } : {}),
      resolvedBranch,
    },
  );
  return cloud;
}

export function vectorPlatformErrorCode(error: unknown): string {
  if (error instanceof VectorPersistenceError) return error.code;
  if (error instanceof Error) {
    if (
      error.name === "MissingAPIError"
      || /MissingAPI/i.test(error.message)
      || /IndexedDB API (?:is )?missing/i.test(error.message)
    ) {
      return "VECTOR_INDEXEDDB_UNAVAILABLE";
    }
    if (
      error.name === "QuotaExceededError"
      || /QuotaExceeded/i.test(error.message)
    ) {
      return "VECTOR_LOCAL_QUOTA_EXCEEDED";
    }
    if (/^VECTOR_[A-Z0-9_]+$/.test(error.message)) return error.message;
  }
  return "VECTOR_LOCAL_UNKNOWN";
}

function localDataFailure(error: unknown): VectorLocalDataState {
  const code = vectorPlatformErrorCode(error);
  if (code === "VECTOR_INDEXEDDB_UNAVAILABLE" || code.includes("MissingAPI")) {
    return {
      status: "unavailable",
      message: "This browser does not expose IndexedDB, so VECTOR cannot claim local saves.",
    };
  }
  if (code === "VECTOR_LOCAL_QUOTA_EXCEEDED" || code.includes("Quota")) {
    return {
      status: "quota",
      message: "Browser storage is full. Existing records remain intact; free storage before writing.",
    };
  }
  return {
    status: "error",
    message: "Owner-scoped VECTOR records could not be loaded. No save or sync state is being claimed.",
  };
}

function capturePlatformError(
  operation: string,
  error: unknown,
  code = vectorPlatformErrorCode(error),
) {
  captureRouteError(error, {
    route: "vector.platform",
    operation,
    area: "vector",
    status: 500,
    code,
  });
}

export function useVectorPlatform({
  reconcileOnReconnect = true,
}: {
  reconcileOnReconnect?: boolean;
} = {}) {
  const supabase = useMemo(() => createClient(), []);
  const repositoryRef = useRef<VectorPersistence | null>(null);
  const deviceIdRef = useRef<string | null>(null);
  const ownerKeyRef = useRef<VectorOwnerKey | null>(null);
  const ownerEpochRef = useRef(0);
  const userIdRef = useRef<string | null>(null);
  const mountedRef = useRef(false);
  const transitionQueueRef = useRef<Promise<void>>(Promise.resolve());
  const settingsQueueRef = useRef<Promise<void>>(Promise.resolve());
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const transitionBarriersRef = useRef(new Set<VectorOwnerTransitionBarrier>());
  const settingsRef = useRef(DEFAULT_VECTOR_RUNTIME_SETTINGS);
  const conflictResolutionKeysRef = useRef(new Map<string, ConflictResolutionKey>());
  const reconciliationAbortRef = useRef<AbortController | null>(null);
  const [view, setView] = useState<PlatformView>(INITIAL_VIEW);

  const readCurrentOwner = useCallback(async (
    repository: VectorPersistence,
    ownerKey: VectorOwnerKey,
    deviceId: string,
    userId: string | null,
  ) => {
    const profile = await repository.ensureProfile(ownerKey, deviceId);
    const verified = await repository.listVerifiedSaves(ownerKey);
    // Verification may quarantine a corrupt row by creating a conflict. Read
    // conflicts only after that pass so the first rendered view is complete.
    const [outbox, conflicts, installs] = await Promise.all([
      repository.listOutbox(ownerKey),
      repository.listConflicts(ownerKey),
      repository.listInstalls(deviceId),
    ]);
    const saves = verified.saves;
    const hasUnscopedQuarantine = hasUnscopedVectorQuarantine(
      verified.unscopedQuarantined,
    );
    const ownerScope = userId ? "account" as const : "anonymous" as const;
    const settings = vectorRuntimeSettingsFromProfile(profile);
    settingsRef.current = settings;
    return {
      profile,
      saves,
      conflicts,
      summaries: buildVectorPersistenceSummaries({
        ownerScope,
        saves,
        outbox,
        conflicts,
        installs,
      }),
      ownerScope,
      hasUnscopedQuarantine,
    };
  }, []);

  const reconcileCloud = useCallback(async (
    repository: VectorPersistence,
    ownerKey: VectorOwnerKey,
    deviceId: string,
    signal?: AbortSignal,
  ): Promise<string | null> => {
    if (!ownerKey.startsWith("user:")) return null;
    const [verified, outbox] = await Promise.all([
      repository.listVerifiedSaves(ownerKey),
      repository.listOutbox(ownerKey),
    ]);
    const saves = verified.saves;
    const pendingGames = new Set<VectorGameSlug>();
    for (const save of saves) {
      if (save.syncState === "pending" || save.syncState === "error") {
        pendingGames.add(save.gameId);
      }
    }
    for (const event of outbox) {
      if (event.status === "pending" || event.status === "error") {
        pendingGames.add(event.gameId);
      }
    }

    let error: string | null = null;
    for (const gameId of pendingGames) {
      const outcome = await syncVectorGame({
        repository,
        ownerKey,
        gameId,
        deviceId,
        signal,
      });
      if (outcome.status === "error") error = outcome.code;
      if (outcome.status === "partial") error = outcome.code;
      if (repository.getActiveOwner() !== ownerKey) return "VECTOR_OWNER_CHANGED";
    }
    const catalog = await bootstrapVectorCloud({
      persistence: repository,
      ownerKey,
      deviceId,
      signal,
    });
    if (catalog.status === "error") {
      error = catalog.code;
    } else {
      if (catalog.status === "partial") error = catalog.code;
      const stateGames = selectVectorStateBootstrapGames({
        pendingGames,
        remoteSaveGames: catalog.response.saves.map((save) => save.gameId),
        remoteConflictGames: catalog.response.conflicts.map((conflict) => conflict.gameId),
      });
      for (const gameId of stateGames) {
        const bootstrap = await bootstrapVectorCloud({
          persistence: repository,
          ownerKey,
          deviceId,
          gameId,
          signal,
        });
        if (bootstrap.status === "error" || bootstrap.status === "partial") {
          error = bootstrap.code;
        }
        if (repository.getActiveOwner() !== ownerKey) return "VECTOR_OWNER_CHANGED";
      }
    }
    if (repository.getActiveOwner() !== ownerKey) return "VECTOR_OWNER_CHANGED";
    return error;
  }, []);

  const refresh = useCallback(async () => {
    const repository = repositoryRef.current;
    const ownerKey = ownerKeyRef.current;
    const deviceId = deviceIdRef.current;
    if (!repository || !ownerKey || !deviceId) return;
    try {
      const loaded = await readCurrentOwner(
        repository,
        ownerKey,
        deviceId,
        userIdRef.current,
      );
      if (!mountedRef.current || ownerKeyRef.current !== ownerKey) return;
      setView((current) => ({
        ...current,
        localDataState: loaded.hasUnscopedQuarantine
          ? {
              status: "error",
              message: "A structurally invalid local save was preserved but cannot be assigned safely to a game. Clear this owner namespace only after recovery review.",
            }
          : { status: "ready" },
        settings: vectorRuntimeSettingsFromProfile(loaded.profile),
        summaries: loaded.summaries,
        saves: loaded.saves,
        conflicts: loaded.conflicts,
        ownerScope: loaded.ownerScope,
        operationError: loaded.hasUnscopedQuarantine
          ? "VECTOR_SAVE_QUARANTINED_UNSCOPED"
          : current.operationError === "VECTOR_SAVE_QUARANTINED_UNSCOPED"
            ? null
            : current.operationError,
      }));
    } catch (error) {
      capturePlatformError("refresh", error);
      if (!mountedRef.current || ownerKeyRef.current !== ownerKey) return;
      setView((current) => ({
        ...current,
        localDataState: localDataFailure(error),
        summaries: [],
        saves: [],
        conflicts: [],
      }));
    }
  }, [readCurrentOwner]);

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;

    const transition = async (userId: string | null) => {
      const repository = repositoryRef.current;
      const deviceId = deviceIdRef.current;
      if (!repository || !deviceId || cancelled) return;
      const expectedOwner = userId
        ? `user:${userId}`
        : `anonymous:${deviceId}`;
      if (
        ownerEpochRef.current > 0
        && ownerKeyRef.current === expectedOwner
        && userIdRef.current === userId
      ) {
        return;
      }
      await settingsQueueRef.current;
      await saveQueueRef.current;
      if (cancelled) return;
      let checkpointError: string | null = null;
      for (const barrier of [...transitionBarriersRef.current]) {
        try {
          await barrier();
        } catch {
          // Identity changes must still complete, but the failed final
          // checkpoint remains visible and observable.
          checkpointError = "VECTOR_OWNER_TRANSITION_CHECKPOINT_FAILED";
          capturePlatformError(
            "owner_transition_checkpoint",
            new Error(checkpointError),
            checkpointError,
          );
        }
      }
      await saveQueueRef.current;
      if (cancelled) return;
      reconciliationAbortRef.current?.abort();
      reconciliationAbortRef.current = null;
      const ownerEpoch = ownerEpochRef.current + 1;
      ownerEpochRef.current = ownerEpoch;
      setView((current) => ({
        ...current,
        localDataState: {
          status: "loading",
          message: "Switching to the verified owner namespace.",
        },
        summaries: [],
        saves: [],
        conflicts: [],
        ownerScope: null,
        ownerEpoch: null,
        adoptionOffer: null,
        operationError: null,
      }));
      try {
        const ownerKey = await changeVectorRepositoryOwner({
          repository,
          deviceId,
          userId,
        });
        if (cancelled) return;
        ownerKeyRef.current = ownerKey;
        userIdRef.current = userId;
        conflictResolutionKeysRef.current.clear();
        let adoptionOffer: AdoptionOffer | null = null;
        if (userId) {
          const anonymousOwner = vectorAnonymousOwner(deviceId);
          const preview = await repository.previewAnonymousAdoption(anonymousOwner, ownerKey);
          if (preview.saves > 0 || preview.events > 0) {
            adoptionOffer = { anonymousOwner, ...preview };
          }
        }
        const publishLoaded = (
          loaded: Awaited<ReturnType<typeof readCurrentOwner>>,
          reconciliationError: string | null,
        ) => {
          if (cancelled || ownerKeyRef.current !== ownerKey) return;
          setView({
            localDataState: loaded.hasUnscopedQuarantine
              ? {
                  status: "error",
                  message: "A structurally invalid local save was preserved but cannot be assigned safely to a game. Clear this owner namespace only after recovery review.",
                }
              : { status: "ready" },
            settings: vectorRuntimeSettingsFromProfile(loaded.profile),
            summaries: loaded.summaries,
            saves: loaded.saves,
            conflicts: loaded.conflicts,
            ownerScope: loaded.ownerScope,
            ownerEpoch,
            adoptionOffer,
            operationError: loaded.hasUnscopedQuarantine
              ? "VECTOR_SAVE_QUARANTINED_UNSCOPED"
              : checkpointError ?? reconciliationError,
          });
        };

        await publishVectorLocalState({
          readLocal: () => readCurrentOwner(repository, ownerKey, deviceId, userId),
          publishLocal: (loaded) => publishLoaded(loaded, null),
        });
      } catch (error) {
        capturePlatformError("owner_transition", error);
        if (cancelled) return;
        ownerKeyRef.current = null;
        ownerEpochRef.current += 1;
        userIdRef.current = null;
        setView({
          ...INITIAL_VIEW,
          localDataState: localDataFailure(error),
          operationError: vectorPlatformErrorCode(error),
        });
      }
    };

    const scheduleTransition = (userId: string | null) => {
      transitionQueueRef.current = transitionQueueRef.current
        .then(() => transition(userId))
        .catch((error) => capturePlatformError("owner_transition_queue", error));
      return transitionQueueRef.current;
    };

    const start = async () => {
      try {
        const opened = await openVectorRepository();
        if (cancelled) return;
        repositoryRef.current = opened.repository;
        deviceIdRef.current = opened.deviceId;
        ownerKeyRef.current = opened.ownerKey;

        const { data: { user }, error } = await supabase.auth.getUser();
        if (error) throw error;
        await scheduleTransition(user?.id ?? null);
      } catch (error) {
        capturePlatformError("initialize", error);
        if (cancelled) return;
        setView({
          ...INITIAL_VIEW,
          localDataState: localDataFailure(error),
          operationError: vectorPlatformErrorCode(error),
        });
      }
    };

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!repositoryRef.current) return;
      const nextUserId = session?.user.id ?? null;
      const currentOwner = ownerKeyRef.current;
      const expectedOwner = nextUserId ? `user:${nextUserId}` : (
        deviceIdRef.current ? `anonymous:${deviceIdRef.current}` : null
      );
      if (currentOwner === expectedOwner) return;
      scheduleTransition(nextUserId);
    });
    void start();

    return () => {
      cancelled = true;
      mountedRef.current = false;
      reconciliationAbortRef.current?.abort();
      reconciliationAbortRef.current = null;
      subscription.unsubscribe();
    };
  }, [readCurrentOwner, supabase]);

  // Cloud reconciliation is intentionally a separate effect. It cannot begin
  // until React has committed a verified local-owner view, so network latency
  // never keeps IndexedDB-backed controls in a loading state.
  useEffect(() => {
    if (
      view.localDataState.status !== "ready"
      || view.ownerScope !== "account"
      || view.ownerEpoch === null
    ) {
      return;
    }
    const repository = repositoryRef.current;
    const ownerKey = ownerKeyRef.current;
    const deviceId = deviceIdRef.current;
    if (
      !repository
      || !ownerKey
      || !ownerKey.startsWith("user:")
      || !deviceId
    ) {
      return;
    }
    const ownerEpoch = view.ownerEpoch;
    const controller = new AbortController();
    reconciliationAbortRef.current?.abort();
    reconciliationAbortRef.current = controller;

    void reconcileCloud(
      repository,
      ownerKey,
      deviceId,
      controller.signal,
    ).then(async (reconciliationError) => {
      if (
        controller.signal.aborted
        || !mountedRef.current
        || ownerKeyRef.current !== ownerKey
        || ownerEpochRef.current !== ownerEpoch
      ) {
        return;
      }
      await refresh();
      if (
        controller.signal.aborted
        || !mountedRef.current
        || ownerKeyRef.current !== ownerKey
        || ownerEpochRef.current !== ownerEpoch
      ) {
        return;
      }
      setView((current) => ({
        ...current,
        operationError: current.operationError === "VECTOR_SAVE_QUARANTINED_UNSCOPED"
          ? current.operationError
          : reconciliationError,
      }));
    }).catch((error) => {
      if (
        controller.signal.aborted
        || !mountedRef.current
        || ownerKeyRef.current !== ownerKey
        || ownerEpochRef.current !== ownerEpoch
      ) {
        return;
      }
      capturePlatformError("initial_reconciliation", error);
      setView((current) => ({
        ...current,
        operationError: vectorPlatformErrorCode(error),
      }));
    }).finally(() => {
      if (reconciliationAbortRef.current === controller) {
        reconciliationAbortRef.current = null;
      }
    });

    return () => {
      controller.abort();
      if (reconciliationAbortRef.current === controller) {
        reconciliationAbortRef.current = null;
      }
    };
  }, [
    reconcileCloud,
    refresh,
    view.localDataState.status,
    view.ownerEpoch,
    view.ownerScope,
  ]);

  const updateSettings = useCallback((next: VectorRuntimeSettings) => {
    const previous = settingsRef.current;
    settingsRef.current = next;
    setView((current) => ({ ...current, settings: next, operationError: null }));
    const changed = ([
      "motionPreference",
      "muted",
      "volume",
      "lowPower",
    ] as const).filter((key) => previous[key] !== next[key]);
    if (changed.length === 0) return;

    const repository = repositoryRef.current;
    const ownerKey = ownerKeyRef.current;
    const deviceId = deviceIdRef.current;
    if (!repository || !ownerKey || !deviceId) return;
    const at = new Date().toISOString();
    const values: Record<string, Json> = {};
    const clocks: Record<string, VectorSettingClock> = {};
    for (const key of changed) {
      values[key] = next[key] as Json;
      clocks[key] = { at, deviceId };
    }

    settingsQueueRef.current = settingsQueueRef.current.then(async () => {
      if (ownerKeyRef.current !== ownerKey) return;
      try {
        await repository.updateProfileSettings({
          ownerKey,
          gameId: SETTINGS_CHANNEL,
          deviceId,
          values,
          clocks,
        });
        await refresh();
      } catch (error) {
        capturePlatformError("settings", error);
        if (!mountedRef.current || ownerKeyRef.current !== ownerKey) return;
        await refresh();
        if (!mountedRef.current || ownerKeyRef.current !== ownerKey) return;
        setView((current) => ({
          ...current,
          localDataState: localDataFailure(error),
          operationError: vectorPlatformErrorCode(error),
        }));
      }
    });
  }, [refresh]);

  const syncGame = useCallback(async (gameId: VectorGameSlug): Promise<VectorSyncOutcome> => {
    const repository = repositoryRef.current;
    const ownerKey = ownerKeyRef.current;
    const deviceId = deviceIdRef.current;
    if (!repository || !ownerKey || !deviceId || !ownerKey.startsWith("user:")) {
      return { status: "idle" };
    }
    setView((current) => ({ ...current, operationError: null }));
    const outcome = await syncVectorGame({ repository, ownerKey, gameId, deviceId });
    await refresh();
    if (
      (outcome.status === "error" || outcome.status === "partial")
      && mountedRef.current
    ) {
      setView((current) => ({ ...current, operationError: outcome.code }));
    }
    return outcome;
  }, [refresh]);

  useEffect(() => {
    const onOnline = () => {
      // A running game may have valid in-memory progress newer than its last
      // checkpoint. Defer pull/merge until the route exits instead of replacing
      // its IndexedDB ancestor underneath the runtime.
      if (!reconcileOnReconnect) return;
      const repository = repositoryRef.current;
      const ownerKey = ownerKeyRef.current;
      const deviceId = deviceIdRef.current;
      if (!repository || !ownerKey || !deviceId || !ownerKey.startsWith("user:")) return;
      void reconcileCloud(repository, ownerKey, deviceId).then(async (code) => {
        if (!mountedRef.current || ownerKeyRef.current !== ownerKey) return;
        await refresh();
        setView((current) => ({ ...current, operationError: code }));
      }).catch((error) => {
        capturePlatformError("reconnect", error);
        if (!mountedRef.current || ownerKeyRef.current !== ownerKey) return;
        setView((current) => ({
          ...current,
          operationError: vectorPlatformErrorCode(error),
        }));
      });
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [reconcileCloud, reconcileOnReconnect, refresh]);

  const adoptAnonymousData = useCallback(async () => {
    const repository = repositoryRef.current;
    const ownerKey = ownerKeyRef.current;
    const deviceId = deviceIdRef.current;
    const offer = view.adoptionOffer;
    if (!repository || !ownerKey || !deviceId || !offer || !ownerKey.startsWith("user:")) return;
    try {
      await repository.adoptAnonymousData(offer.anonymousOwner, ownerKey, deviceId);
      setView((current) => ({ ...current, adoptionOffer: null }));
      await refresh();
    } catch (error) {
      capturePlatformError("anonymous_adoption", error);
      setView((current) => ({
        ...current,
        operationError: vectorPlatformErrorCode(error),
      }));
      throw error;
    }
  }, [refresh, view.adoptionOffer]);

  const declineAnonymousData = useCallback(() => {
    setView((current) => ({ ...current, adoptionOffer: null }));
  }, []);

  const clearOwnerData = useCallback(async () => {
    const repository = repositoryRef.current;
    const ownerKey = ownerKeyRef.current;
    const deviceId = deviceIdRef.current;
    if (!repository || !ownerKey || !deviceId) return;
    try {
      await repository.clearOwnerData(ownerKey);
      await repository.activateOwner(ownerKey);
      await repository.ensureProfile(ownerKey, deviceId);
      await refresh();
    } catch (error) {
      capturePlatformError("clear_owner", error);
      setView((current) => ({
        ...current,
        operationError: vectorPlatformErrorCode(error),
      }));
      throw error;
    }
  }, [refresh]);

  const saveGame = useCallback(async (input: {
    gameId: VectorGameSlug;
    slotId: string;
    gameVersion: string;
    saveSchemaVersion: number;
    ownerEpoch: number;
    expectedAncestor: VectorSaveAncestor | null;
    save: VectorSerializedSave;
    reason: VectorSaveReason;
  }): Promise<VectorLocalSave> => {
    const repository = repositoryRef.current;
    const ownerKey = ownerKeyRef.current;
    const deviceId = deviceIdRef.current;
    if (!repository || !ownerKey || !deviceId) throw new Error("VECTOR_REPOSITORY_NOT_READY");
    assertVectorOwnerEpoch(
      ownerKeyRef.current,
      ownerEpochRef.current,
      ownerKey,
      input.ownerEpoch,
    );
    if (input.save.schemaVersion !== input.saveSchemaVersion) {
      throw new Error("VECTOR_SAVE_SCHEMA_MISMATCH");
    }
    const parsedState = vectorJsonSchema.safeParse(input.save.data);
    if (!parsedState.success) throw new Error("VECTOR_SAVE_JSON_INVALID");
    const pending = saveQueueRef.current.then(async () => {
      assertVectorOwnerEpoch(
        ownerKeyRef.current,
        ownerEpochRef.current,
        ownerKey,
        input.ownerEpoch,
      );
      return repository.saveLocalWithAncestor({
        ownerKey,
        gameId: input.gameId,
        slotId: input.slotId,
        gameVersion: input.gameVersion,
        saveSchemaVersion: input.saveSchemaVersion,
        deviceId,
        seed: input.save.seed ?? null,
        state: parsedState.data,
        checkpointLabel: input.reason,
      }, input.expectedAncestor);
    });
    saveQueueRef.current = pending.then(() => undefined, () => undefined);
    try {
      const result = await pending;
      if (
        ownerKeyRef.current === ownerKey
        && ownerEpochRef.current === input.ownerEpoch
      ) {
        await refresh();
      }
      if (result.status === "conflict") {
        const code = "VECTOR_SAVE_CONFLICT_CREATED";
        if (
          mountedRef.current
          && ownerKeyRef.current === ownerKey
          && ownerEpochRef.current === input.ownerEpoch
        ) {
          setView((current) => ({ ...current, operationError: code }));
        }
        throw new Error(code);
      }
      return result.save;
    } catch (error) {
      const code = vectorPlatformErrorCode(error);
      if (code !== "VECTOR_SAVE_CONFLICT_CREATED") {
        capturePlatformError("save", error, code);
      }
      if (
        mountedRef.current
        && ownerKeyRef.current === ownerKey
        && ownerEpochRef.current === input.ownerEpoch
      ) {
        if (code !== "VECTOR_SAVE_CONFLICT_CREATED") {
          await refresh().catch(() => undefined);
        }
        setView((current) => ({ ...current, operationError: code }));
      }
      throw error;
    }
  }, [refresh]);

  const recordScore = useCallback(async (
    gameId: VectorGameSlug,
    input: VectorGameScoreInput,
  ): Promise<void> => {
    const repository = repositoryRef.current;
    const ownerKey = ownerKeyRef.current;
    if (!repository || !ownerKey) throw new Error("VECTOR_REPOSITORY_NOT_READY");
    try {
      await repository.enqueueEvent(ownerKey, gameId, {
        kind: "score",
        idempotencyKey: crypto.randomUUID(),
        localRevision: Date.now(),
        occurredAt: new Date().toISOString(),
        payload: {
          mode: input.mode,
          challengeId: input.challengeId,
          value: input.value,
        },
      });
      if (mountedRef.current && ownerKeyRef.current === ownerKey) {
        await refresh();
      }
    } catch (error) {
      const code = vectorPlatformErrorCode(error);
      capturePlatformError("record_score", error, code);
      if (mountedRef.current && ownerKeyRef.current === ownerKey) {
        setView((current) => ({ ...current, operationError: code }));
      }
      throw error;
    }
  }, [refresh]);

  const getBestScore = useCallback(async (
    gameId: VectorGameSlug,
    mode: string,
    challengeId: string | null,
  ): Promise<number | null> => {
    const repository = repositoryRef.current;
    const ownerKey = ownerKeyRef.current;
    if (!repository || !ownerKey) return null;
    try {
      const profile = await repository.loadProfile(ownerKey);
      if (!profile) return null;
      return profile.scores[vectorScoreKey({ gameId, mode, challengeId })] ?? null;
    } catch (error) {
      capturePlatformError("get_best_score", error);
      return null;
    }
  }, []);

  const registerOwnerTransitionBarrier = useCallback((
    barrier: VectorOwnerTransitionBarrier,
  ) => {
    transitionBarriersRef.current.add(barrier);
    return () => {
      transitionBarriersRef.current.delete(barrier);
    };
  }, []);

  const quarantineSaveMigrationFailure = useCallback(async (input: {
    gameId: VectorGameSlug;
    slotId: string;
    ownerEpoch: number;
    expectedAncestor: VectorSaveAncestor;
    code: "SAVE_SCHEMA_NEWER" | "SAVE_MIGRATOR_MISSING" | "SAVE_MIGRATION_FAILED";
  }) => {
    const repository = repositoryRef.current;
    const ownerKey = ownerKeyRef.current;
    if (!repository || !ownerKey) throw new Error("VECTOR_REPOSITORY_NOT_READY");
    const reasons: Record<typeof input.code, VectorMigrationFailureReason> = {
      SAVE_SCHEMA_NEWER: "save_schema_newer",
      SAVE_MIGRATOR_MISSING: "save_migrator_missing",
      SAVE_MIGRATION_FAILED: "save_migration_failed",
    };
    const pending = saveQueueRef.current.then(async () => {
      assertVectorOwnerEpoch(
        ownerKeyRef.current,
        ownerEpochRef.current,
        ownerKey,
        input.ownerEpoch,
      );
      await repository.quarantineMigrationFailure(
        ownerKey,
        input.gameId,
        input.slotId,
        reasons[input.code],
        input.expectedAncestor,
      );
    });
    saveQueueRef.current = pending.then(() => undefined, () => undefined);
    try {
      await pending;
      if (
        ownerKeyRef.current === ownerKey
        && ownerEpochRef.current === input.ownerEpoch
      ) {
        await refresh();
      }
    } catch (error) {
      capturePlatformError("save_migration_quarantine", error);
      throw error;
    }
  }, [refresh]);

  const retrySaveMigration = useCallback(async (input: {
    conflictId: string;
    ownerEpoch: number;
    gameVersion: string;
    targetSaveSchemaVersion: number;
    migrators: readonly VectorSaveMigrator[];
  }): Promise<VectorLocalSave> => {
    const repository = repositoryRef.current;
    const ownerKey = ownerKeyRef.current;
    const deviceId = deviceIdRef.current;
    const conflict = view.conflicts.find((candidate) => (
      candidate.id === input.conflictId
    ));
    if (!repository || !ownerKey || !deviceId) {
      throw new Error("VECTOR_REPOSITORY_NOT_READY");
    }
    if (!conflict || conflict.ownerKey !== ownerKey) {
      throw new Error("VECTOR_CONFLICT_NOT_FOUND");
    }
    assertVectorOwnerEpoch(
      ownerKeyRef.current,
      ownerEpochRef.current,
      ownerKey,
      input.ownerEpoch,
    );
    const save = prepareVectorMigrationRetry(
      conflict,
      input.targetSaveSchemaVersion,
      input.migrators,
    );
    if (save.schemaVersion !== input.targetSaveSchemaVersion) {
      throw new Error("VECTOR_SAVE_SCHEMA_MISMATCH");
    }
    const parsedState = vectorJsonSchema.safeParse(save.data);
    if (!parsedState.success) throw new Error("VECTOR_SAVE_JSON_INVALID");

    const pending = saveQueueRef.current.then(async () => {
      assertVectorOwnerEpoch(
        ownerKeyRef.current,
        ownerEpochRef.current,
        ownerKey,
        input.ownerEpoch,
      );
      return repository.retryMigrationFailure({
        ownerKey,
        gameId: conflict.gameId,
        slotId: conflict.slotId,
        gameVersion: input.gameVersion,
        saveSchemaVersion: input.targetSaveSchemaVersion,
        deviceId,
        seed: save.seed ?? null,
        state: parsedState.data,
        checkpointLabel: "migration",
        conflictId: conflict.id,
        expectedConflictVersion: conflict.conflictVersion,
        expectedAncestor: {
          localRevision: conflict.local.localRevision,
          checksum: conflict.local.checksum,
        },
      });
    });
    saveQueueRef.current = pending.then(() => undefined, () => undefined);
    try {
      const result = await pending;
      if (
        ownerKeyRef.current === ownerKey
        && ownerEpochRef.current === input.ownerEpoch
      ) {
        await refresh();
      }
      return result.save;
    } catch (error) {
      const code = vectorPlatformErrorCode(error);
      capturePlatformError("retry_save_migration", error, code);
      if (
        mountedRef.current
        && ownerKeyRef.current === ownerKey
        && ownerEpochRef.current === input.ownerEpoch
      ) {
        await refresh().catch(() => undefined);
        setView((current) => ({ ...current, operationError: code }));
      }
      throw error;
    }
  }, [refresh, view.conflicts]);

  const resolveConflict = useCallback(async (
    conflictId: string,
    resolution: ConflictResolution,
    targetSlotId?: string,
  ) => {
    const repository = repositoryRef.current;
    const ownerKey = ownerKeyRef.current;
    const conflict = view.conflicts.find((candidate) => candidate.id === conflictId);
    if (!repository || !ownerKey || !conflict) {
      const code = "VECTOR_CONFLICT_NOT_FOUND";
      setView((current) => ({ ...current, operationError: code }));
      throw new Error(code);
    }
    const idempotencyKey = getOrCreateVectorConflictResolutionKey(
      conflictResolutionKeysRef.current,
      conflict.id,
      resolution,
      targetSlotId,
    );
    setView((current) => ({ ...current, operationError: null }));
    let outcome: Awaited<ReturnType<typeof executeVectorConflictResolution>>;
    try {
      outcome = await executeVectorConflictResolution({
        repository,
        ownerKey,
        conflict,
        resolution,
        targetSlotId,
        idempotencyKey,
      });
    } catch (error) {
      capturePlatformError("resolve_conflict", error);
      const code = vectorPlatformErrorCode(error);
      if (mountedRef.current && ownerKeyRef.current === ownerKey) {
        setView((current) => ({ ...current, operationError: code }));
      }
      throw error;
    }
    if (outcome.status === "error") {
      if (mountedRef.current && ownerKeyRef.current === ownerKey) {
        setView((current) => ({ ...current, operationError: outcome.code }));
      }
      throw new Error(outcome.code);
    }
    try {
      await refresh();
      conflictResolutionKeysRef.current.delete(conflict.id);
    } catch (error) {
      capturePlatformError("resolve_conflict_refresh", error);
      throw error;
    }
  }, [refresh, view.conflicts]);

  return {
    ...view,
    updateSettings,
    syncGame,
    adoptAnonymousData,
    declineAnonymousData,
    clearOwnerData,
    saveGame,
    recordScore,
    getBestScore,
    quarantineSaveMigrationFailure,
    retrySaveMigration,
    registerOwnerTransitionBarrier,
    resolveConflict,
    refresh,
  };
}
