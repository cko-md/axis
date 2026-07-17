import Dexie, { type Table } from "dexie";
import type { Json } from "@/lib/supabase/database.types";
import {
  VECTOR_EVENT_MAX_PAYLOAD_BYTES,
  VECTOR_MAX_SAVE_SLOTS,
  VECTOR_PROFILE_MAX_DOCUMENT_BYTES,
  VECTOR_SAVE_MAX_STATE_BYTES,
  vectorLocalSaveInputSchema,
  vectorIdempotencyKeySchema,
  vectorChecksumSchema,
  vectorGameIdSchema,
  vectorJsonSchema,
  vectorSavePushSchema,
  vectorSlotIdSchema,
  vectorSyncEventSchema,
  vectorVersionSchema,
  type VectorBootstrapResponse,
  type VectorCloudConflict,
  type VectorCloudSave,
  type VectorConflictResolution,
  type VectorResolvedBranch,
  type VectorSyncEvent,
  type VectorSyncRequest,
  type VectorSyncResponse,
} from "@/lib/vector/contracts";
import {
  canonicalVectorJson,
  checksumVectorState,
  compareVectorText,
  hashVectorPayload,
  vectorJsonBytes,
} from "@/lib/vector/checksum";
import type {
  VectorLocalConflict,
  VectorLocalInstall,
  VectorLocalMeta,
  VectorLocalOutboxEvent,
  VectorLocalProfile,
  VectorLocalSave,
  VectorOwnerKey,
  VectorSettingClock,
} from "@/lib/vector/persistence-types";
import type { VectorGameSlug } from "@/lib/vector/types";
import {
  compareVectorSettingClocks,
  mergeVectorBestScore,
  mergeVectorMonotonicCounters,
  mergeVectorSettings,
  mergeVectorStringSet,
} from "@/lib/vector/merge";

const VECTOR_DB_NAME = "axis-vector";
const ACTIVE_OWNER_META_KEY = "active-owner";
const DEVICE_ID_META_KEY = "device-id";
const SETTING_CLOCK_MAX_FUTURE_MS = 5 * 60 * 1000;
const OWNER_KEY = /^(anonymous:[a-z0-9][a-z0-9._:-]{7,127}|user:[0-9a-f-]{36})$/i;

export class VectorPersistenceError extends Error {
  constructor(
    readonly code:
      | "VECTOR_OWNER_INVALID"
      | "VECTOR_OWNER_INACTIVE"
      | "VECTOR_SAVE_INPUT_INVALID"
      | "VECTOR_SAVE_TOO_LARGE"
      | "VECTOR_SAVE_SLOT_LIMIT"
      | "VECTOR_SAVE_CONFLICT_OPEN"
      | "VECTOR_EVENT_TOO_LARGE"
      | "VECTOR_EVENT_CORRUPT"
      | "VECTOR_COUNTER_OVERFLOW"
      | "VECTOR_IDEMPOTENCY_REUSED"
      | "VECTOR_LOCAL_QUOTA_EXCEEDED"
      | "VECTOR_SAVE_CORRUPT"
      | "VECTOR_PROFILE_INPUT_INVALID"
      | "VECTOR_SETTING_CLOCK_FUTURE"
      | "VECTOR_PROFILE_TOO_LARGE"
      | "VECTOR_CONFLICT_NOT_FOUND"
      | "VECTOR_CONFLICT_AUTHORITY_INVALID"
      | "VECTOR_CONFLICT_ALREADY_RESOLVED"
      | "VECTOR_CONFLICT_VERSION_MISMATCH"
      | "VECTOR_CONFLICT_TARGET_INVALID"
      | "VECTOR_CONFLICT_TARGET_EXISTS"
      | "VECTOR_CONFLICT_BRANCH_INVALID"
      | "VECTOR_CONFLICT_INPUT_INVALID"
      | "VECTOR_SYNC_RESPONSE_SCOPE_INVALID"
      | "VECTOR_SYNC_RESPONSE_DUPLICATE_RESULT"
      | "VECTOR_CLOUD_PAYLOAD_INVALID",
  ) {
    super(code);
    this.name = "VectorPersistenceError";
  }
}

export class VectorDatabase extends Dexie {
  profiles!: Table<VectorLocalProfile, VectorOwnerKey>;
  saves!: Table<VectorLocalSave, string>;
  outbox!: Table<VectorLocalOutboxEvent, string>;
  conflicts!: Table<VectorLocalConflict, string>;
  installs!: Table<VectorLocalInstall, string>;
  meta!: Table<VectorLocalMeta, string>;

  constructor(name = VECTOR_DB_NAME) {
    super(name);
    this.version(1).stores({
      profiles: "&ownerKey, syncState, updatedAt",
      saves: "&id, ownerKey, gameId, slotId, [ownerKey+gameId+slotId], [ownerKey+gameId], [ownerKey+syncState], updatedAt",
      outbox: "&id, ownerKey, gameId, status, [ownerKey+gameId+status], createdAt",
      conflicts: "&id, ownerKey, gameId, slotId, status, [ownerKey+gameId+status], createdAt",
      installs: "&id, deviceId, gameId, [deviceId+gameId], validationState, updatedAt",
      meta: "&key, updatedAt",
    });
  }
}

let singleton: VectorDatabase | null = null;
const repositoryByDatabase = new WeakMap<VectorDatabase, VectorPersistence>();

export function getVectorDatabase(): VectorDatabase {
  if (typeof indexedDB === "undefined") {
    throw new Error("VECTOR_INDEXEDDB_UNAVAILABLE");
  }
  singleton ??= new VectorDatabase();
  return singleton;
}

export function vectorAnonymousOwner(deviceId: string): VectorOwnerKey {
  const owner = `anonymous:${deviceId}` as VectorOwnerKey;
  assertVectorOwnerKey(owner);
  return owner;
}

export function vectorUserOwner(userId: string): VectorOwnerKey {
  const owner = `user:${userId}` as VectorOwnerKey;
  assertVectorOwnerKey(owner);
  return owner;
}

export function assertVectorOwnerKey(ownerKey: string): asserts ownerKey is VectorOwnerKey {
  if (!OWNER_KEY.test(ownerKey)) throw new VectorPersistenceError("VECTOR_OWNER_INVALID");
}

function saveId(ownerKey: VectorOwnerKey, gameId: VectorGameSlug, slotId: string): string {
  return `${ownerKey}|${gameId}|${slotId}`;
}

function installId(deviceId: string, gameId: VectorGameSlug): string {
  return `${deviceId}|${gameId}`;
}

function isQuotaError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String(error.name) : "";
  const code = "code" in error ? Number(error.code) : NaN;
  return name === "QuotaExceededError" || code === 22 || code === 1014;
}

function nowIso(): string {
  return new Date().toISOString();
}

function scoreKey(input: {
  gameId: VectorGameSlug;
  mode: string;
  challengeId: string | null;
}): string {
  return `${input.gameId}:${input.mode}:${input.challengeId ?? ""}`;
}

function achievementKey(gameId: VectorGameSlug, achievementId: string): string {
  return `${gameId}:${achievementId}`;
}

function counterKey(gameId: VectorGameSlug, counterId: string): string {
  return `${gameId}:${counterId}`;
}

async function checksumLocalSaveEnvelope(input: Pick<
  VectorLocalSave,
  | "ownerKey"
  | "gameId"
  | "slotId"
  | "gameVersion"
  | "saveSchemaVersion"
  | "deviceId"
  | "pendingIdempotencyKey"
  | "localRevision"
  | "checksum"
  | "seed"
  | "state"
  | "checkpointLabel"
>): Promise<string> {
  return hashVectorPayload({
    ownerKey: input.ownerKey,
    gameId: input.gameId,
    slotId: input.slotId,
    gameVersion: input.gameVersion,
    saveSchemaVersion: input.saveSchemaVersion,
    deviceId: input.deviceId,
    pendingIdempotencyKey: input.pendingIdempotencyKey,
    localRevision: input.localRevision,
    checksum: input.checksum,
    seed: input.seed,
    state: input.state,
    checkpointLabel: input.checkpointLabel ?? null,
  } as Json);
}

async function checksumLocalConflictBranch(input: {
  ownerKey: VectorOwnerKey;
  gameId: VectorGameSlug;
  slotId: string;
  branch: "local" | "server";
  value: VectorLocalConflict["local"] | VectorLocalConflict["server"];
}): Promise<string> {
  const revision = input.branch === "local"
    ? { localRevision: (input.value as VectorLocalConflict["local"]).localRevision }
    : { serverRevision: (input.value as VectorLocalConflict["server"]).serverRevision };
  const local = input.branch === "local"
    ? input.value as VectorLocalConflict["local"]
    : null;
  return hashVectorPayload({
    ownerKey: input.ownerKey,
    gameId: input.gameId,
    slotId: input.slotId,
    branch: input.branch,
    ...revision,
    ...(local?.checkpointLabel === undefined
      ? {}
      : { checkpointLabel: local.checkpointLabel }),
    gameVersion: input.value.gameVersion,
    saveSchemaVersion: input.value.saveSchemaVersion,
    checksum: input.value.checksum,
    seed: input.value.seed,
    state: input.value.state ?? null,
    updatedAt: input.value.updatedAt,
  } as Json);
}

function normalizeProfile(profile: VectorLocalProfile): VectorLocalProfile {
  return {
    ...profile,
    scores: profile.scores ?? {},
  };
}

function assertProfileDocumentBytes(input: Pick<
  VectorLocalProfile,
  "settings" | "settingClocks" | "counters"
>): void {
  if (
    vectorJsonBytes(input.settings as Json) > VECTOR_PROFILE_MAX_DOCUMENT_BYTES ||
    vectorJsonBytes(input.settingClocks as unknown as Json) > VECTOR_PROFILE_MAX_DOCUMENT_BYTES ||
    vectorJsonBytes(input.counters as unknown as Json) > VECTOR_PROFILE_MAX_DOCUMENT_BYTES
  ) {
    throw new VectorPersistenceError("VECTOR_PROFILE_TOO_LARGE");
  }
}

function resolvedBranchMatchesConflict(input: {
  conflict: VectorCloudConflict;
  resolution: VectorConflictResolution["resolution"];
  targetSlotId?: string;
  branch: VectorResolvedBranch;
}): boolean {
  const { conflict, resolution, targetSlotId, branch } = input;
  const expectedSlot = resolution === "fork-local" ? targetSlotId : conflict.slotId;
  if (!expectedSlot || branch.slotId !== expectedSlot) return false;

  if (resolution === "accept-server") {
    if (conflict.server.serverRevision === 0) {
      return branch.deleted &&
        branch.serverRevision === 0 &&
        branch.clientRevision === null &&
        branch.gameVersion === null &&
        branch.saveSchemaVersion === null &&
        branch.checksum === null &&
        branch.seed === null;
    }
    return !branch.deleted &&
      branch.serverRevision === conflict.server.serverRevision &&
      branch.clientRevision !== null &&
      branch.gameVersion === conflict.server.gameVersion &&
      branch.saveSchemaVersion === conflict.server.saveSchemaVersion &&
      branch.checksum === conflict.server.checksum &&
      branch.seed === conflict.server.seed;
  }

  return !branch.deleted &&
    branch.serverRevision === (
      resolution === "fork-local" ? 1 : conflict.server.serverRevision + 1
    ) &&
    branch.clientRevision === conflict.local.localRevision &&
    branch.gameVersion === conflict.local.gameVersion &&
    branch.saveSchemaVersion === conflict.local.saveSchemaVersion &&
    branch.checksum === conflict.local.checksum &&
    branch.seed === conflict.local.seed;
}

function inferConflictAuthority(conflict: VectorLocalConflict): "local" | "cloud" {
  if (conflict.authority === "local" || conflict.authority === "cloud") {
    return conflict.authority;
  }
  return conflict.reason === "revision_mismatch" || conflict.reason === "server_missing"
    ? "cloud"
    : "local";
}

function localConflictBranchIsUnusable(reason: string): boolean {
  return reason === "local_checksum_mismatch" ||
    reason === "save_schema_newer" ||
    reason === "save_migrator_missing" ||
    reason === "save_migration_failed";
}

function outboxErrorIsTerminal(code: string | null): boolean {
  return code === "VECTOR_SETTING_CLOCK_FUTURE" || code === "VECTOR_COUNTER_OVERFLOW";
}

function normalizeConflict(
  ownerKey: VectorOwnerKey,
  conflict: VectorLocalConflict,
): VectorLocalConflict {
  return {
    ...conflict,
    ownerKey,
    authority: inferConflictAuthority(conflict),
    resolution: conflict.resolution ?? null,
  };
}

export type VectorSaveLocalInput = {
  ownerKey: VectorOwnerKey;
  gameId: VectorGameSlug;
  slotId: string;
  gameVersion: string;
  saveSchemaVersion: number;
  deviceId: string;
  seed: string | null;
  state: Json;
  checkpointLabel?: string;
  updatedAt?: string;
};

export type VectorSaveAncestor = {
  localRevision: number;
  checksum: string;
};

export type VectorSaveLocalCasResult =
  | { status: "saved"; save: VectorLocalSave }
  | { status: "conflict"; conflict: VectorLocalConflict };

export type VectorRetryMigrationFailureInput = VectorSaveLocalInput & {
  conflictId: string;
  expectedConflictVersion: number;
  expectedAncestor: VectorSaveAncestor;
};

export type VectorMigrationFailureReason =
  | "save_schema_newer"
  | "save_migrator_missing"
  | "save_migration_failed";

export type VectorSyncSnapshot = {
  body: VectorSyncRequest;
  transmittedSaves: Array<{ slotId: string; localRevision: number; idempotencyKey: string }>;
  transmittedEvents: Array<{
    idempotencyKey: string;
    kind: VectorSyncEvent["kind"];
    localRevision: number;
  }>;
};

export class VectorPersistence {
  private activeOwner: VectorOwnerKey | null = null;
  private initialization: Promise<{ deviceId: string; activeOwner: VectorOwnerKey }> | null = null;
  private ownerTransition: Promise<void> = Promise.resolve();

  constructor(readonly db: VectorDatabase = getVectorDatabase()) {}

  async initialize(): Promise<{ deviceId: string; activeOwner: VectorOwnerKey }> {
    this.initialization ??= this.initializeOnce().catch((error) => {
      this.initialization = null;
      throw error;
    });
    return this.initialization;
  }

  private async initializeOnce(): Promise<{ deviceId: string; activeOwner: VectorOwnerKey }> {
    await this.db.open();
    const deviceId = await this.db.transaction("rw", this.db.meta, async () => {
      const device = await this.db.meta.get(DEVICE_ID_META_KEY);
      if (typeof device?.value === "string") return device.value;
      const generated = crypto.randomUUID();
      await this.db.meta.put({
        key: DEVICE_ID_META_KEY,
        value: generated,
        updatedAt: nowIso(),
      });
      return generated;
    });
    const storedOwner = await this.db.meta.get(ACTIVE_OWNER_META_KEY);
    const candidate = typeof storedOwner?.value === "string" ? storedOwner.value : null;
    const activeOwner = candidate && OWNER_KEY.test(candidate)
      ? candidate as VectorOwnerKey
      : vectorAnonymousOwner(deviceId);
    await this.activateOwner(activeOwner);
    return { deviceId, activeOwner };
  }

  getActiveOwner(): VectorOwnerKey | null {
    return this.activeOwner;
  }

  async activateOwner(ownerKey: VectorOwnerKey): Promise<void> {
    assertVectorOwnerKey(ownerKey);
    const transition = this.ownerTransition.then(() => this.activateOwnerNow(ownerKey));
    this.ownerTransition = transition.catch(() => undefined);
    return transition;
  }

  private async activateOwnerNow(ownerKey: VectorOwnerKey): Promise<void> {
    await this.db.transaction("rw", this.db.saves, this.db.outbox, this.db.meta, async () => {
      const storedOwner = await this.db.meta.get(ACTIVE_OWNER_META_KEY);
      const previous = typeof storedOwner?.value === "string" && OWNER_KEY.test(storedOwner.value)
        ? storedOwner.value as VectorOwnerKey
        : null;
      if (previous && previous !== ownerKey) {
        await this.db.outbox
          .where("ownerKey")
          .equals(previous)
          .and((event) => event.status !== "frozen")
          .modify({ status: "frozen", updatedAt: nowIso() });
        await this.db.saves
          .where("[ownerKey+syncState]")
          .equals([previous, "syncing"])
          .modify({ syncState: "pending" });
      }
      await this.db.outbox
        .where("ownerKey")
        .equals(ownerKey)
        .and((event) => event.status === "frozen" || event.status === "sending")
        .modify((event) => {
          event.status = outboxErrorIsTerminal(event.lastErrorCode) ? "error" : "pending";
          event.updatedAt = nowIso();
        });
      await this.db.saves
        .where("[ownerKey+syncState]")
        .equals([ownerKey, "syncing"])
        .modify({ syncState: "pending" });
      await this.db.meta.put({ key: ACTIVE_OWNER_META_KEY, value: ownerKey, updatedAt: nowIso() });
    });
    this.activeOwner = ownerKey;
  }

  private assertMemoryActive(ownerKey: VectorOwnerKey): void {
    assertVectorOwnerKey(ownerKey);
    if (this.activeOwner !== ownerKey) {
      throw new VectorPersistenceError("VECTOR_OWNER_INACTIVE");
    }
  }

  private async assertActive(ownerKey: VectorOwnerKey): Promise<void> {
    this.assertMemoryActive(ownerKey);
    const storedOwner = await this.db.meta.get(ACTIVE_OWNER_META_KEY);
    if (storedOwner?.value !== ownerKey) {
      if (this.activeOwner === ownerKey) this.activeOwner = null;
      throw new VectorPersistenceError("VECTOR_OWNER_INACTIVE");
    }
  }

  private async mergeCloudSave(
    ownerKey: VectorOwnerKey,
    remote: VectorCloudSave,
  ): Promise<void> {
    if (remote.deletedAt) return;
    const id = saveId(ownerKey, remote.gameId, remote.slotId);
    const local = await this.db.saves.get(id);
    if (!local) {
      if (remote.state === undefined) return;
      const hydrated: VectorLocalSave = {
        id,
        ownerKey,
        gameId: remote.gameId,
        slotId: remote.slotId,
        gameVersion: remote.gameVersion,
        saveSchemaVersion: remote.saveSchemaVersion,
        localRevision: remote.clientRevision,
        serverRevision: remote.serverRevision,
        pendingIdempotencyKey: crypto.randomUUID(),
        deviceId: remote.deviceId,
        checksum: remote.checksum,
        seed: remote.seed,
        state: remote.state,
        updatedAt: remote.updatedAt,
        syncState: "synced",
        lastErrorCode: null,
      };
      hydrated.integrityChecksum = await Dexie.waitFor(checksumLocalSaveEnvelope(hydrated));
      await this.db.saves.put(hydrated);
      return;
    }
    const corruptConflict = await this.db.conflicts
      .where("ownerKey")
      .equals(ownerKey)
      .and((conflict) => (
        conflict.gameId === remote.gameId &&
        conflict.slotId === remote.slotId &&
        localConflictBranchIsUnusable(conflict.reason) &&
        conflict.status === "open" &&
        conflict.local.localRevision === local.localRevision &&
        conflict.local.checksum === local.checksum
      ))
      .first();
    if (corruptConflict) {
      if (remote.state !== undefined) {
        const server: VectorLocalConflict["server"] = {
          serverRevision: remote.serverRevision,
          gameVersion: remote.gameVersion,
          saveSchemaVersion: remote.saveSchemaVersion,
          checksum: remote.checksum,
          seed: remote.seed,
          state: remote.state,
          updatedAt: remote.updatedAt,
        };
        server.integrityChecksum = await Dexie.waitFor(checksumLocalConflictBranch({
          ownerKey,
          gameId: remote.gameId,
          slotId: remote.slotId,
          branch: "server",
          value: server,
        }));
        await this.db.conflicts.put({
          ...normalizeConflict(ownerKey, corruptConflict),
          conflictVersion: corruptConflict.conflictVersion + 1,
          server,
        });
      }
      await this.db.saves.update(id, {
        serverRevision: Math.max(local.serverRevision, remote.serverRevision),
        syncState: "conflict",
        lastErrorCode: corruptConflict.reason === "local_checksum_mismatch"
          ? "VECTOR_SAVE_CORRUPT"
          : corruptConflict.reason.toUpperCase(),
      });
      return;
    }
    const envelopeMatches = (
      local.checksum === remote.checksum &&
      local.gameVersion === remote.gameVersion &&
      local.saveSchemaVersion === remote.saveSchemaVersion &&
      local.seed === remote.seed
    );
    if (envelopeMatches) {
      await this.db.saves.update(id, {
        serverRevision: Math.max(local.serverRevision, remote.serverRevision),
        syncState: "synced",
        lastErrorCode: null,
      });
      return;
    }
    const dirty = local.syncState !== "synced";
    const remoteIsKnownAncestor = dirty && remote.serverRevision <= local.serverRevision;
    if (remoteIsKnownAncestor) {
      await this.db.saves.update(id, {
        serverRevision: Math.max(local.serverRevision, remote.serverRevision),
      });
      return;
    }
    if (!dirty) {
      if (remote.state === undefined) return;
      const hydrated: VectorLocalSave = {
        ...local,
        gameVersion: remote.gameVersion,
        saveSchemaVersion: remote.saveSchemaVersion,
        localRevision: remote.clientRevision,
        serverRevision: remote.serverRevision,
        pendingIdempotencyKey: crypto.randomUUID(),
        deviceId: remote.deviceId,
        checksum: remote.checksum,
        seed: remote.seed,
        state: remote.state,
        updatedAt: remote.updatedAt,
        syncState: "synced",
        lastErrorCode: null,
      };
      hydrated.integrityChecksum = await Dexie.waitFor(checksumLocalSaveEnvelope(hydrated));
      await this.db.saves.put(hydrated);
      return;
    }
    const existingConflict = await this.db.conflicts
      .where("ownerKey")
      .equals(ownerKey)
      .and((conflict) => (
        conflict.gameId === remote.gameId &&
        conflict.slotId === remote.slotId &&
        conflict.status === "open" &&
        conflict.local.localRevision === local.localRevision &&
        conflict.local.checksum === local.checksum &&
        conflict.server.serverRevision === remote.serverRevision &&
        conflict.server.checksum === remote.checksum
      ))
      .first();
    if (!existingConflict) {
      const created: VectorLocalConflict = {
        id: crypto.randomUUID(),
        ownerKey,
        authority: "local",
        gameId: remote.gameId,
        slotId: remote.slotId,
        reason: "remote_divergence",
        conflictVersion: 1,
        status: "open",
        resolution: null,
        local: {
          localRevision: local.localRevision,
          gameVersion: local.gameVersion,
          saveSchemaVersion: local.saveSchemaVersion,
          checksum: local.checksum,
          seed: local.seed,
          state: local.state,
          checkpointLabel: local.checkpointLabel ?? null,
          updatedAt: local.updatedAt,
        },
        server: {
          serverRevision: remote.serverRevision,
          gameVersion: remote.gameVersion,
          saveSchemaVersion: remote.saveSchemaVersion,
          checksum: remote.checksum,
          seed: remote.seed,
          ...(remote.state === undefined ? {} : { state: remote.state }),
          updatedAt: remote.updatedAt,
        },
        createdAt: nowIso(),
        resolvedAt: null,
      };
      created.local.integrityChecksum = await Dexie.waitFor(checksumLocalConflictBranch({
        ownerKey,
        gameId: created.gameId,
        slotId: created.slotId,
        branch: "local",
        value: created.local,
      }));
      created.server.integrityChecksum = await Dexie.waitFor(checksumLocalConflictBranch({
        ownerKey,
        gameId: created.gameId,
        slotId: created.slotId,
        branch: "server",
        value: created.server,
      }));
      await this.db.conflicts.add(created);
    }
    await this.db.saves.update(id, {
      syncState: "conflict",
      lastErrorCode: "VECTOR_SAVE_CONFLICT",
    });
  }

  private async assertCloudSavePayload(remote: VectorCloudSave): Promise<void> {
    if (remote.state === undefined) return;
    if (vectorJsonBytes(remote.state) > VECTOR_SAVE_MAX_STATE_BYTES) {
      throw new VectorPersistenceError("VECTOR_CLOUD_PAYLOAD_INVALID");
    }
    let checksum: string;
    try {
      checksum = await checksumVectorState(remote.state);
    } catch {
      throw new VectorPersistenceError("VECTOR_CLOUD_PAYLOAD_INVALID");
    }
    if (checksum !== remote.checksum) {
      throw new VectorPersistenceError("VECTOR_CLOUD_PAYLOAD_INVALID");
    }
  }

  private async assertCloudConflictPayload(conflict: VectorCloudConflict): Promise<void> {
    if (conflict.local.state !== undefined) {
      await this.assertCloudSavePayload({
        gameId: conflict.gameId,
        slotId: conflict.slotId,
        gameVersion: conflict.local.gameVersion,
        saveSchemaVersion: conflict.local.saveSchemaVersion,
        serverRevision: Math.max(1, conflict.server.serverRevision),
        clientRevision: conflict.local.localRevision,
        deviceId: "cloud-conflict",
        checksum: conflict.local.checksum,
        seed: conflict.local.seed,
        state: conflict.local.state,
        updatedAt: conflict.local.updatedAt,
        deletedAt: null,
      });
    }
    if (conflict.server.state !== undefined) {
      if (
        conflict.server.gameVersion === null ||
        conflict.server.saveSchemaVersion === null ||
        conflict.server.checksum === null ||
        conflict.server.updatedAt === null
      ) {
        throw new VectorPersistenceError("VECTOR_CLOUD_PAYLOAD_INVALID");
      }
      await this.assertCloudSavePayload({
        gameId: conflict.gameId,
        slotId: conflict.slotId,
        gameVersion: conflict.server.gameVersion,
        saveSchemaVersion: conflict.server.saveSchemaVersion,
        serverRevision: Math.max(1, conflict.server.serverRevision),
        clientRevision: conflict.local.localRevision,
        deviceId: "cloud-conflict",
        checksum: conflict.server.checksum,
        seed: conflict.server.seed,
        state: conflict.server.state,
        updatedAt: conflict.server.updatedAt,
        deletedAt: null,
      });
    }
  }

  private async verifyLocalSave(row: VectorLocalSave): Promise<boolean> {
    try {
      if (
        row.id !== saveId(row.ownerKey, row.gameId, row.slotId) ||
        !vectorIdempotencyKeySchema.safeParse(row.pendingIdempotencyKey).success ||
        !vectorLocalSaveInputSchema.safeParse({
          gameId: row.gameId,
          slotId: row.slotId,
          gameVersion: row.gameVersion,
          saveSchemaVersion: row.saveSchemaVersion,
          deviceId: row.deviceId,
          seed: row.seed,
          state: row.state,
          ...(row.checkpointLabel ? { checkpointLabel: row.checkpointLabel } : {}),
          updatedAt: row.updatedAt,
        }).success ||
        !vectorSavePushSchema.safeParse({
          idempotencyKey: row.pendingIdempotencyKey,
          slotId: row.slotId,
          gameVersion: row.gameVersion,
          saveSchemaVersion: row.saveSchemaVersion,
          expectedServerRevision: row.serverRevision,
          localRevision: row.localRevision,
          checksum: row.checksum,
          seed: row.seed,
          state: row.state,
          updatedAt: row.updatedAt,
        }).success
      ) {
        return false;
      }
      if (await checksumVectorState(row.state) !== row.checksum) return false;
      if (!row.integrityChecksum) return true;
      return await checksumLocalSaveEnvelope(row) === row.integrityChecksum;
    } catch {
      return false;
    }
  }

  private async upgradeLegacySaveIntegrity(
    ownerKey: VectorOwnerKey,
    row: VectorLocalSave,
  ): Promise<void> {
    if (row.integrityChecksum) return;
    await this.db.transaction("rw", this.db.meta, this.db.saves, async () => {
      await this.assertActive(ownerKey);
      const current = await this.db.saves.get(row.id);
      if (
        !current ||
        current.integrityChecksum ||
        current.ownerKey !== ownerKey ||
        current.localRevision !== row.localRevision ||
        current.updatedAt !== row.updatedAt
      ) {
        return;
      }
      const checksum = await Dexie.waitFor(checksumLocalSaveEnvelope(current));
      await this.db.saves.update(current.id, { integrityChecksum: checksum });
      row.integrityChecksum = checksum;
    });
  }

  async applyBootstrap(
    ownerKey: VectorOwnerKey,
    deviceId: string,
    response: VectorBootstrapResponse,
    gameId?: VectorGameSlug,
  ): Promise<void> {
    await this.assertActive(ownerKey);
    const scopedItems = [
      ...response.saves.map((item) => item.gameId),
      ...response.scores.map((item) => item.gameId),
      ...response.achievements.map((item) => item.gameId),
      ...response.conflicts.map((item) => item.gameId),
    ];
    if (gameId && scopedItems.some((itemGameId) => itemGameId !== gameId)) {
      throw new VectorPersistenceError("VECTOR_SYNC_RESPONSE_SCOPE_INVALID");
    }
    if (response.profile) assertProfileDocumentBytes(response.profile);
    for (const save of response.saves) await this.assertCloudSavePayload(save);
    for (const conflict of response.conflicts) {
      await this.assertCloudConflictPayload(conflict);
    }
    await this.db.transaction(
      "rw",
      this.db.meta,
      this.db.profiles,
      this.db.saves,
      this.db.conflicts,
      async () => {
        await this.assertActive(ownerKey);
        if (response.profile) {
        const local = await this.db.profiles.get(ownerKey);
        if (!local) {
            const hydratedProfile: VectorLocalProfile = {
              ownerKey,
              deviceId,
              settings: response.profile.settings,
              settingClocks: response.profile.settingClocks,
              unlocks: response.profile.unlocks,
              scores: {},
              counters: response.profile.counters,
              serverRevision: response.profile.serverRevision,
              syncState: "synced",
              updatedAt: response.profile.updatedAt,
            };
            assertProfileDocumentBytes(hydratedProfile);
            await this.db.profiles.put(hydratedProfile);
          } else {
            const settings = mergeVectorSettings({
              currentValues: local.settings,
              currentClocks: local.settingClocks,
              incomingValues: response.profile.settings,
              incomingClocks: response.profile.settingClocks,
            });
            const normalized = normalizeProfile(local);
            const mergedProfile: VectorLocalProfile = {
              ...normalized,
              settings: settings.values,
              settingClocks: settings.clocks,
              unlocks: mergeVectorStringSet(normalized.unlocks, response.profile.unlocks),
              counters: mergeVectorMonotonicCounters(
                normalized.counters,
                response.profile.counters,
              ),
              serverRevision: Math.max(
                local.serverRevision,
                response.profile.serverRevision,
              ),
              syncState: local.syncState === "synced" ? "synced" : local.syncState,
              updatedAt: local.updatedAt > response.profile.updatedAt
                ? local.updatedAt
                : response.profile.updatedAt,
            };
            assertProfileDocumentBytes(mergedProfile);
            await this.db.profiles.put(mergedProfile);
          }
        }
        if (response.scores.length > 0 || response.achievements.length > 0) {
          const current = normalizeProfile((await this.db.profiles.get(ownerKey)) ?? {
            ownerKey,
            deviceId,
            settings: {},
            settingClocks: {},
            unlocks: [],
            scores: {},
            counters: {},
            serverRevision: 0,
            syncState: ownerKey.startsWith("user:") ? "synced" : "local-only",
            updatedAt: response.serverTime,
          });
          const scores = { ...current.scores };
          for (const score of response.scores) {
            const key = scoreKey(score);
            scores[key] = mergeVectorBestScore(scores[key] ?? null, score.score);
          }
          const unlocks = mergeVectorStringSet(
            current.unlocks,
            response.achievements.map((achievement) => (
              achievementKey(achievement.gameId, achievement.achievementId)
            )),
          );
          const mergedProfile: VectorLocalProfile = {
            ...current,
            scores,
            unlocks,
            updatedAt: compareVectorText(current.updatedAt, response.serverTime) >= 0
              ? current.updatedAt
              : response.serverTime,
          };
          assertProfileDocumentBytes(mergedProfile);
          await this.db.profiles.put(mergedProfile);
        }
        const incomingConflictIds = new Set(response.conflicts.map((conflict) => conflict.id));
        if (!response.truncated.conflicts && !response.truncated.saves) {
          const storedCloudConflicts = await this.db.conflicts
            .where("ownerKey")
            .equals(ownerKey)
            .and((conflict) => (
              inferConflictAuthority(conflict) === "cloud" &&
              conflict.status === "open" &&
              (!gameId || conflict.gameId === gameId) &&
              !incomingConflictIds.has(conflict.id)
            ))
            .toArray();
          for (const conflict of storedCloudConflicts) {
            await this.db.conflicts.put({
              ...normalizeConflict(ownerKey, conflict),
              status: "resolved",
              conflictVersion: conflict.conflictVersion + 1,
              resolvedAt: response.serverTime,
            });
            const id = saveId(ownerKey, conflict.gameId, conflict.slotId);
            const current = await this.db.saves.get(id);
            if (!current) continue;
            const unchanged = (
              current.localRevision === conflict.local.localRevision &&
              current.checksum === conflict.local.checksum
            );
            if (!unchanged) {
              if (!response.saves.some((save) => (
                save.gameId === conflict.gameId && save.slotId === conflict.slotId
              ))) {
                await this.db.saves.update(id, {
                  serverRevision: 0,
                  syncState: ownerKey.startsWith("user:") ? "pending" : "local-only",
                  lastErrorCode: null,
                });
              }
              continue;
            }
            const returned = response.saves.find((save) => (
              save.gameId === conflict.gameId && save.slotId === conflict.slotId
            ));
            if (returned) {
              await this.db.saves.update(id, {
                syncState: "synced",
                lastErrorCode: null,
              });
            } else {
              await this.db.saves.delete(id);
            }
          }
        }
        for (const conflict of response.conflicts) {
          await this.db.conflicts.put(cloudConflictToLocal(ownerKey, conflict));
        }
        for (const save of response.saves) {
          await this.mergeCloudSave(ownerKey, save);
        }
      },
    );
  }

  async ensureProfile(ownerKey: VectorOwnerKey, deviceId: string): Promise<VectorLocalProfile> {
    await this.assertActive(ownerKey);
    return this.db.transaction("rw", this.db.meta, this.db.profiles, async () => {
      await this.assertActive(ownerKey);
      const existing = await this.db.profiles.get(ownerKey);
      if (existing) {
        const normalized = normalizeProfile(existing);
        if (existing.scores === undefined) await this.db.profiles.put(normalized);
        return normalized;
      }
      const profile: VectorLocalProfile = {
        ownerKey,
        deviceId,
        settings: {},
        settingClocks: {},
        unlocks: [],
        scores: {},
        counters: {},
        serverRevision: 0,
        syncState: ownerKey.startsWith("user:") ? "synced" : "local-only",
        updatedAt: nowIso(),
      };
      await this.db.profiles.add(profile);
      return profile;
    });
  }

  async loadProfile(ownerKey: VectorOwnerKey): Promise<VectorLocalProfile | null> {
    await this.assertActive(ownerKey);
    const profile = await this.db.transaction("r", this.db.meta, this.db.profiles, async () => {
      await this.assertActive(ownerKey);
      return this.db.profiles.get(ownerKey);
    });
    return profile ? normalizeProfile(profile) : null;
  }

  async updateProfileSettings(input: {
    ownerKey: VectorOwnerKey;
    gameId: VectorGameSlug;
    deviceId: string;
    values: Record<string, Json>;
    clocks: Record<string, VectorSettingClock>;
  }): Promise<VectorLocalProfile> {
    await this.assertActive(input.ownerKey);
    if (Object.values(input.clocks).some((clock) => (
      Date.parse(clock.at) > Date.now() + SETTING_CLOCK_MAX_FUTURE_MS
    ))) {
      throw new VectorPersistenceError("VECTOR_SETTING_CLOCK_FUTURE");
    }
    const occurredAt = nowIso();
    const baseEvent = vectorSyncEventSchema.safeParse({
      kind: "settings",
      idempotencyKey: crypto.randomUUID(),
      localRevision: Date.now(),
      occurredAt,
      payload: { values: input.values, clocks: input.clocks },
    });
    if (!baseEvent.success) throw new VectorPersistenceError("VECTOR_PROFILE_INPUT_INVALID");
    const eventJson = canonicalVectorJson(baseEvent.data as unknown as Json);
    if (new TextEncoder().encode(eventJson).byteLength > VECTOR_EVENT_MAX_PAYLOAD_BYTES) {
      throw new VectorPersistenceError("VECTOR_EVENT_TOO_LARGE");
    }
    try {
      return await this.db.transaction(
        "rw",
        this.db.meta,
        this.db.profiles,
        this.db.outbox,
        async () => {
          await this.assertActive(input.ownerKey);
          const existing = await this.db.profiles.get(input.ownerKey);
          const profile = existing ? normalizeProfile(existing) : {
            ownerKey: input.ownerKey,
            deviceId: input.deviceId,
            settings: {},
            settingClocks: {},
            unlocks: [],
            scores: {},
            counters: {},
            serverRevision: 0,
            syncState: input.ownerKey.startsWith("user:") ? "synced" : "local-only",
            updatedAt: occurredAt,
          } satisfies VectorLocalProfile;
          const clocks = { ...input.clocks };
          for (const [key, requested] of Object.entries(clocks)) {
            const current = profile.settingClocks[key];
            if (!current) continue;
            const comparison = compareVectorSettingClocks(requested, current);
            if (comparison === null || comparison > 0) continue;
            const currentTime = Date.parse(current.at);
            if (!Number.isFinite(currentTime)) continue;
            const successorTime = Math.max(Date.now(), currentTime + 1);
            if (successorTime > Date.now() + SETTING_CLOCK_MAX_FUTURE_MS) {
              throw new VectorPersistenceError("VECTOR_SETTING_CLOCK_FUTURE");
            }
            clocks[key] = {
              at: new Date(successorTime).toISOString(),
              deviceId: requested.deviceId,
            };
          }
          const event = vectorSyncEventSchema.safeParse({
            ...baseEvent.data,
            payload: { values: input.values, clocks },
          });
          if (!event.success) {
            throw new VectorPersistenceError("VECTOR_PROFILE_INPUT_INVALID");
          }
          const finalEventJson = canonicalVectorJson(event.data as unknown as Json);
          if (
            new TextEncoder().encode(finalEventJson).byteLength >
            VECTOR_EVENT_MAX_PAYLOAD_BYTES
          ) {
            throw new VectorPersistenceError("VECTOR_EVENT_TOO_LARGE");
          }
          const payloadHash = await Dexie.waitFor(
            hashVectorPayload(event.data as unknown as Json),
          );
          const merged = mergeVectorSettings({
            currentValues: profile.settings,
            currentClocks: profile.settingClocks,
            incomingValues: input.values,
            incomingClocks: clocks,
          });
          const updated: VectorLocalProfile = {
            ...profile,
            settings: merged.values,
            settingClocks: merged.clocks,
            syncState: input.ownerKey.startsWith("user:") ? "pending" : "local-only",
            updatedAt: occurredAt,
          };
          assertProfileDocumentBytes(updated);
          const row: VectorLocalOutboxEvent = {
            id: event.data.idempotencyKey,
            ownerKey: input.ownerKey,
            gameId: input.gameId,
            event: event.data,
            payloadHash,
            status: input.ownerKey.startsWith("user:") ? "pending" : "frozen",
            attemptCount: 0,
            lastErrorCode: null,
            createdAt: occurredAt,
            updatedAt: occurredAt,
          };
          await this.db.profiles.put(updated);
          await this.db.outbox.add(row);
          return updated;
        },
      );
    } catch (error) {
      if (isQuotaError(error)) throw new VectorPersistenceError("VECTOR_LOCAL_QUOTA_EXCEEDED");
      throw error;
    }
  }

  async saveLocal(input: VectorSaveLocalInput): Promise<VectorLocalSave> {
    await this.assertActive(input.ownerKey);
    const parsedInput = vectorLocalSaveInputSchema.safeParse({
      gameId: input.gameId,
      slotId: input.slotId,
      gameVersion: input.gameVersion,
      saveSchemaVersion: input.saveSchemaVersion,
      deviceId: input.deviceId,
      seed: input.seed,
      state: input.state,
      ...(input.checkpointLabel === undefined ? {} : {
        checkpointLabel: input.checkpointLabel,
      }),
      ...(input.updatedAt === undefined ? {} : { updatedAt: input.updatedAt }),
    });
    if (!parsedInput.success) {
      throw new VectorPersistenceError("VECTOR_SAVE_INPUT_INVALID");
    }
    const validated = parsedInput.data;
    if (vectorJsonBytes(validated.state) > VECTOR_SAVE_MAX_STATE_BYTES) {
      throw new VectorPersistenceError("VECTOR_SAVE_TOO_LARGE");
    }
    const checksum = await checksumVectorState(validated.state);
    const id = saveId(input.ownerKey, validated.gameId, validated.slotId);
    try {
      return await this.db.transaction(
        "rw",
        this.db.meta,
        this.db.saves,
        this.db.conflicts,
        async () => {
        await this.assertActive(input.ownerKey);
        const openConflict = await this.db.conflicts
          .where("ownerKey")
          .equals(input.ownerKey)
          .and((conflict) => (
            conflict.gameId === validated.gameId &&
            conflict.slotId === validated.slotId &&
            conflict.status === "open"
          ))
          .first();
        if (openConflict) throw new VectorPersistenceError("VECTOR_SAVE_CONFLICT_OPEN");
        const previous = await this.db.saves.get(id);
        if (previous && !await Dexie.waitFor(this.verifyLocalSave(previous))) {
          throw new VectorPersistenceError("VECTOR_SAVE_CORRUPT");
        }
        if (!previous) {
          const slotCount = await this.db.saves
            .where("[ownerKey+gameId]")
            .equals([input.ownerKey, validated.gameId])
            .count();
          if (slotCount >= VECTOR_MAX_SAVE_SLOTS) {
            throw new VectorPersistenceError("VECTOR_SAVE_SLOT_LIMIT");
          }
        }
        const saved: VectorLocalSave = {
          id,
          ownerKey: input.ownerKey,
          gameId: validated.gameId,
          slotId: validated.slotId,
          gameVersion: validated.gameVersion,
          saveSchemaVersion: validated.saveSchemaVersion,
          localRevision: (previous?.localRevision ?? 0) + 1,
          serverRevision: previous?.serverRevision ?? 0,
          pendingIdempotencyKey: crypto.randomUUID(),
          deviceId: validated.deviceId,
          checksum,
          seed: validated.seed,
          state: validated.state,
          ...(validated.checkpointLabel
            ? { checkpointLabel: validated.checkpointLabel }
            : {}),
          updatedAt: validated.updatedAt ?? nowIso(),
          syncState: input.ownerKey.startsWith("user:") ? "pending" : "local-only",
          lastErrorCode: null,
        };
        saved.integrityChecksum = await Dexie.waitFor(checksumLocalSaveEnvelope(saved));
        await this.db.saves.put(saved);
        return saved;
      },
      );
    } catch (error) {
      if (isQuotaError(error)) throw new VectorPersistenceError("VECTOR_LOCAL_QUOTA_EXCEEDED");
      throw error;
    }
  }

  async saveLocalWithAncestor(
    input: VectorSaveLocalInput,
    expectedAncestor: VectorSaveAncestor | null,
  ): Promise<VectorSaveLocalCasResult> {
    await this.assertActive(input.ownerKey);
    if (expectedAncestor !== null && (
      !Number.isSafeInteger(expectedAncestor.localRevision) ||
      expectedAncestor.localRevision <= 0 ||
      !vectorChecksumSchema.safeParse(expectedAncestor.checksum).success
    )) {
      throw new VectorPersistenceError("VECTOR_SAVE_INPUT_INVALID");
    }
    const parsedInput = vectorLocalSaveInputSchema.safeParse({
      gameId: input.gameId,
      slotId: input.slotId,
      gameVersion: input.gameVersion,
      saveSchemaVersion: input.saveSchemaVersion,
      deviceId: input.deviceId,
      seed: input.seed,
      state: input.state,
      ...(input.checkpointLabel === undefined ? {} : {
        checkpointLabel: input.checkpointLabel,
      }),
      ...(input.updatedAt === undefined ? {} : { updatedAt: input.updatedAt }),
    });
    if (!parsedInput.success) {
      throw new VectorPersistenceError("VECTOR_SAVE_INPUT_INVALID");
    }
    const validated = parsedInput.data;
    if (vectorJsonBytes(validated.state) > VECTOR_SAVE_MAX_STATE_BYTES) {
      throw new VectorPersistenceError("VECTOR_SAVE_TOO_LARGE");
    }
    const checksum = await checksumVectorState(validated.state);
    const id = saveId(input.ownerKey, validated.gameId, validated.slotId);
    const attemptedUpdatedAt = validated.updatedAt ?? nowIso();
    const attemptedLocalRevision = (expectedAncestor?.localRevision ?? 0) + 1;

    try {
      return await this.db.transaction(
        "rw",
        this.db.meta,
        this.db.saves,
        this.db.conflicts,
        async () => {
          await this.assertActive(input.ownerKey);
          const current = await this.db.saves.get(id);
          if (current && !await Dexie.waitFor(this.verifyLocalSave(current))) {
            throw new VectorPersistenceError("VECTOR_SAVE_CORRUPT");
          }
          if (current && !current.integrityChecksum) {
            current.integrityChecksum = await Dexie.waitFor(checksumLocalSaveEnvelope(current));
            await this.db.saves.update(current.id, {
              integrityChecksum: current.integrityChecksum,
            });
          }

          const ancestorMatches = expectedAncestor === null
            ? current === undefined
            : current !== undefined && (
              current.localRevision === expectedAncestor.localRevision &&
              current.checksum === expectedAncestor.checksum
            );
          const openConflicts = await this.db.conflicts
            .where("ownerKey")
            .equals(input.ownerKey)
            .and((conflict) => (
              conflict.gameId === validated.gameId &&
              conflict.slotId === validated.slotId &&
              conflict.status === "open"
            ))
            .toArray();

          if (ancestorMatches) {
            if (openConflicts.length > 0) {
              throw new VectorPersistenceError("VECTOR_SAVE_CONFLICT_OPEN");
            }
            if (!current) {
              const slotCount = await this.db.saves
                .where("[ownerKey+gameId]")
                .equals([input.ownerKey, validated.gameId])
                .count();
              if (slotCount >= VECTOR_MAX_SAVE_SLOTS) {
                throw new VectorPersistenceError("VECTOR_SAVE_SLOT_LIMIT");
              }
            }
            const saved: VectorLocalSave = {
              id,
              ownerKey: input.ownerKey,
              gameId: validated.gameId,
              slotId: validated.slotId,
              gameVersion: validated.gameVersion,
              saveSchemaVersion: validated.saveSchemaVersion,
              localRevision: (current?.localRevision ?? 0) + 1,
              serverRevision: current?.serverRevision ?? 0,
              pendingIdempotencyKey: crypto.randomUUID(),
              deviceId: validated.deviceId,
              checksum,
              seed: validated.seed,
              state: validated.state,
              ...(validated.checkpointLabel
                ? { checkpointLabel: validated.checkpointLabel }
                : {}),
              updatedAt: attemptedUpdatedAt,
              syncState: input.ownerKey.startsWith("user:") ? "pending" : "local-only",
              lastErrorCode: null,
            };
            saved.integrityChecksum = await Dexie.waitFor(checksumLocalSaveEnvelope(saved));
            await this.db.saves.put(saved);
            return { status: "saved", save: saved };
          }

          const currentLocalRevision = current?.localRevision ?? null;
          const currentIntegrityChecksum = current?.integrityChecksum ?? null;
          const existing = openConflicts.find((conflict) => (
            conflict.reason === "local_concurrent_write" &&
            conflict.local.localRevision === attemptedLocalRevision &&
            conflict.local.gameVersion === validated.gameVersion &&
            conflict.local.saveSchemaVersion === validated.saveSchemaVersion &&
            conflict.local.checksum === checksum &&
            conflict.local.seed === validated.seed &&
            (conflict.local.checkpointLabel ?? null) ===
              (validated.checkpointLabel ?? null) &&
            (conflict.expectedAncestorLocalRevision ?? null) ===
              (expectedAncestor?.localRevision ?? null) &&
            (conflict.expectedAncestorChecksum ?? null) ===
              (expectedAncestor?.checksum ?? null) &&
            (conflict.currentLocalRevision ?? null) === currentLocalRevision &&
            (conflict.currentIntegrityChecksum ?? null) === currentIntegrityChecksum
          ));
          if (existing) {
            return { status: "conflict", conflict: normalizeConflict(input.ownerKey, existing) };
          }
          if (openConflicts.length > 0) {
            throw new VectorPersistenceError("VECTOR_SAVE_CONFLICT_OPEN");
          }

          const conflict: VectorLocalConflict = {
            id: crypto.randomUUID(),
            ownerKey: input.ownerKey,
            authority: "local",
            gameId: validated.gameId,
            slotId: validated.slotId,
            reason: "local_concurrent_write",
            conflictVersion: 1,
            status: "open",
            resolution: null,
            expectedAncestorLocalRevision: expectedAncestor?.localRevision ?? null,
            expectedAncestorChecksum: expectedAncestor?.checksum ?? null,
            currentLocalRevision,
            currentIntegrityChecksum,
            currentSyncState: current?.syncState ?? null,
            currentLastErrorCode: current?.lastErrorCode ?? null,
            local: {
              localRevision: attemptedLocalRevision,
              gameVersion: validated.gameVersion,
              saveSchemaVersion: validated.saveSchemaVersion,
              checksum,
              seed: validated.seed,
              state: validated.state,
              ...(validated.checkpointLabel
                ? { checkpointLabel: validated.checkpointLabel }
                : {}),
              updatedAt: attemptedUpdatedAt,
            },
            server: current ? {
              serverRevision: current.serverRevision,
              gameVersion: current.gameVersion,
              saveSchemaVersion: current.saveSchemaVersion,
              checksum: current.checksum,
              seed: current.seed,
              state: current.state,
              updatedAt: current.updatedAt,
            } : {
              serverRevision: 0,
              gameVersion: null,
              saveSchemaVersion: null,
              checksum: null,
              seed: null,
              updatedAt: null,
            },
            createdAt: nowIso(),
            resolvedAt: null,
          };
          conflict.local.integrityChecksum = await Dexie.waitFor(
            checksumLocalConflictBranch({
              ownerKey: input.ownerKey,
              gameId: conflict.gameId,
              slotId: conflict.slotId,
              branch: "local",
              value: conflict.local,
            }),
          );
          conflict.server.integrityChecksum = await Dexie.waitFor(
            checksumLocalConflictBranch({
              ownerKey: input.ownerKey,
              gameId: conflict.gameId,
              slotId: conflict.slotId,
              branch: "server",
              value: conflict.server,
            }),
          );
          await this.db.conflicts.add(conflict);
          if (current) {
            await this.db.saves.update(current.id, {
              syncState: "conflict",
              lastErrorCode: "VECTOR_LOCAL_CONCURRENT_WRITE",
            });
          }
          return { status: "conflict", conflict };
        },
      );
    } catch (error) {
      if (isQuotaError(error)) throw new VectorPersistenceError("VECTOR_LOCAL_QUOTA_EXCEEDED");
      throw error;
    }
  }

  async loadSave(
    ownerKey: VectorOwnerKey,
    gameId: VectorGameSlug,
    slotId: string,
  ): Promise<VectorLocalSave | null> {
    await this.assertActive(ownerKey);
    const row = await this.db.transaction("r", this.db.meta, this.db.saves, async () => {
      await this.assertActive(ownerKey);
      return this.db.saves.get(saveId(ownerKey, gameId, slotId));
    });
    if (!row) return null;
    const verified = await this.verifyLocalSave(row);
    if (verified) {
      await this.upgradeLegacySaveIntegrity(ownerKey, row);
      return row;
    }
    await this.quarantineCorruptSave(ownerKey, row);
    throw new VectorPersistenceError("VECTOR_SAVE_CORRUPT");
  }

  private async quarantineCorruptSave(
    ownerKey: VectorOwnerKey,
    row: VectorLocalSave,
  ): Promise<void> {
    const parsedGameId = vectorGameIdSchema.safeParse(row.gameId);
    const parsedSlotId = vectorSlotIdSchema.safeParse(row.slotId);
    const parsedState = vectorJsonSchema.safeParse(row.state);
    let safeState: Json = { quarantined: true, rawStateExportUnavailable: true };
    if (parsedState.success) {
      try {
        if (vectorJsonBytes(parsedState.data) <= VECTOR_SAVE_MAX_STATE_BYTES) {
          safeState = parsedState.data;
        }
      } catch {
        // Keep the bounded sentinel; malformed source remains preserved in the save row.
      }
    }
    const safeChecksum = vectorChecksumSchema.safeParse(row.checksum).success
      ? row.checksum
      : await checksumVectorState(safeState);
    const safeGameVersion = vectorVersionSchema.safeParse(row.gameVersion).success
      ? row.gameVersion
      : "0.0.0";
    const safeSchemaVersion = Number.isSafeInteger(row.saveSchemaVersion) && (
      row.saveSchemaVersion > 0 && row.saveSchemaVersion <= 10_000
    ) ? row.saveSchemaVersion : 1;
    const safeRevision = Number.isSafeInteger(row.localRevision) && row.localRevision > 0
      ? row.localRevision
      : 1;
    const safeServerRevision = Number.isSafeInteger(row.serverRevision) && row.serverRevision >= 0
      ? row.serverRevision
      : 0;
    const safeUpdatedAt = Number.isFinite(Date.parse(row.updatedAt)) ? row.updatedAt : nowIso();
    const safeSeed = row.seed === null || (
      typeof row.seed === "string" && row.seed.length <= 256
    ) ? row.seed : null;
    await this.db.transaction(
      "rw",
      this.db.meta,
      this.db.saves,
      this.db.conflicts,
      async () => {
      await this.assertActive(ownerKey);
      const current = await this.db.saves.get(row.id);
      if (
        !current ||
        current.ownerKey !== ownerKey ||
        current.localRevision !== row.localRevision ||
        current.checksum !== row.checksum ||
        current.updatedAt !== row.updatedAt
      ) {
        return;
      }
      if (!parsedGameId.success || !parsedSlotId.success) {
        await this.db.saves.update(row.id, {
          syncState: "conflict",
          lastErrorCode: "VECTOR_SAVE_CORRUPT",
        });
        return;
      }
      const existing = await this.db.conflicts
        .where("ownerKey")
        .equals(ownerKey)
        .and((conflict) => (
          conflict.gameId === parsedGameId.data &&
          conflict.slotId === parsedSlotId.data &&
          conflict.reason === "local_checksum_mismatch" &&
          conflict.status === "open" &&
          conflict.local.checksum === safeChecksum
        ))
        .first();
      if (!existing) {
        const created: VectorLocalConflict = {
          id: crypto.randomUUID(),
          ownerKey,
          authority: "local",
          gameId: parsedGameId.data,
          slotId: parsedSlotId.data,
          reason: "local_checksum_mismatch",
          conflictVersion: 1,
          status: "open",
          resolution: null,
          local: {
            localRevision: safeRevision,
            gameVersion: safeGameVersion,
            saveSchemaVersion: safeSchemaVersion,
            checksum: safeChecksum,
            seed: safeSeed,
            state: safeState,
            checkpointLabel: row.checkpointLabel ?? null,
            updatedAt: safeUpdatedAt,
          },
          server: {
            serverRevision: safeServerRevision,
            gameVersion: null,
            saveSchemaVersion: null,
            checksum: null,
            seed: null,
            updatedAt: null,
          },
          createdAt: nowIso(),
          resolvedAt: null,
        };
        created.local.integrityChecksum = await Dexie.waitFor(
          checksumLocalConflictBranch({
            ownerKey,
            gameId: created.gameId,
            slotId: created.slotId,
            branch: "local",
            value: created.local,
          }),
        );
        created.server.integrityChecksum = await Dexie.waitFor(
          checksumLocalConflictBranch({
            ownerKey,
            gameId: created.gameId,
            slotId: created.slotId,
            branch: "server",
            value: created.server,
          }),
        );
        await this.db.conflicts.add(created);
      }
      await this.db.saves.update(row.id, {
        syncState: "conflict",
        lastErrorCode: "VECTOR_SAVE_CORRUPT",
      });
    },
    );
  }

  async listVerifiedSaves(
    ownerKey: VectorOwnerKey,
    gameId?: VectorGameSlug,
  ): Promise<{
    saves: VectorLocalSave[];
    quarantined: number;
    unscopedQuarantined: number;
  }> {
    await this.assertActive(ownerKey);
    const rows = await this.db.transaction("r", this.db.meta, this.db.saves, async () => {
      await this.assertActive(ownerKey);
      return this.db.saves.where("ownerKey").equals(ownerKey).toArray();
    });
    const saves: VectorLocalSave[] = [];
    let quarantined = 0;
    let unscopedQuarantined = 0;
    for (const row of rows) {
      if (gameId && row.gameId !== gameId) continue;
      const verified = await this.verifyLocalSave(row);
      if (verified) {
        await this.upgradeLegacySaveIntegrity(ownerKey, row);
        saves.push(row);
      } else {
        if (
          !vectorGameIdSchema.safeParse(row.gameId).success
          || !vectorSlotIdSchema.safeParse(row.slotId).success
        ) {
          unscopedQuarantined += 1;
        }
        await this.quarantineCorruptSave(ownerKey, row);
        quarantined += 1;
      }
    }
    saves.sort((left, right) => compareVectorText(right.updatedAt, left.updatedAt));
    return { saves, quarantined, unscopedQuarantined };
  }

  async quarantineMigrationFailure(
    ownerKey: VectorOwnerKey,
    gameId: VectorGameSlug,
    slotId: string,
    reason: VectorMigrationFailureReason,
    expectedAncestor: VectorSaveAncestor,
  ): Promise<VectorLocalConflict> {
    await this.assertActive(ownerKey);
    if (
      !localConflictBranchIsUnusable(reason) ||
      !Number.isSafeInteger(expectedAncestor.localRevision) ||
      expectedAncestor.localRevision <= 0 ||
      !vectorChecksumSchema.safeParse(expectedAncestor.checksum).success
    ) {
      throw new VectorPersistenceError("VECTOR_CONFLICT_INPUT_INVALID");
    }
    const row = await this.loadSave(ownerKey, gameId, slotId);
    if (!row) throw new VectorPersistenceError("VECTOR_CONFLICT_NOT_FOUND");
    if (
      row.localRevision !== expectedAncestor.localRevision ||
      row.checksum !== expectedAncestor.checksum
    ) {
      throw new VectorPersistenceError("VECTOR_CONFLICT_VERSION_MISMATCH");
    }
    return this.db.transaction(
      "rw",
      this.db.meta,
      this.db.saves,
      this.db.conflicts,
      async () => {
        await this.assertActive(ownerKey);
        const current = await this.db.saves.get(row.id);
        if (
          !current ||
          current.localRevision !== row.localRevision ||
          current.integrityChecksum !== row.integrityChecksum
        ) {
          throw new VectorPersistenceError("VECTOR_CONFLICT_VERSION_MISMATCH");
        }
        const existing = await this.db.conflicts
          .where("ownerKey")
          .equals(ownerKey)
          .and((conflict) => (
            conflict.gameId === gameId &&
            conflict.slotId === slotId &&
            conflict.reason === reason &&
            conflict.status === "open" &&
            conflict.local.localRevision === row.localRevision &&
            conflict.local.checksum === row.checksum
          ))
          .first();
        if (existing) return normalizeConflict(ownerKey, existing);
        const conflict: VectorLocalConflict = {
          id: crypto.randomUUID(),
          ownerKey,
          authority: "local",
          gameId,
          slotId,
          reason,
          conflictVersion: 1,
          status: "open",
          resolution: null,
          local: {
            localRevision: row.localRevision,
            gameVersion: row.gameVersion,
            saveSchemaVersion: row.saveSchemaVersion,
            checksum: row.checksum,
            seed: row.seed,
            state: row.state,
            checkpointLabel: row.checkpointLabel ?? null,
            updatedAt: row.updatedAt,
          },
          server: {
            serverRevision: row.serverRevision,
            gameVersion: null,
            saveSchemaVersion: null,
            checksum: null,
            seed: null,
            updatedAt: null,
          },
          createdAt: nowIso(),
          resolvedAt: null,
        };
        conflict.local.integrityChecksum = await Dexie.waitFor(
          checksumLocalConflictBranch({
            ownerKey,
            gameId,
            slotId,
            branch: "local",
            value: conflict.local,
          }),
        );
        conflict.server.integrityChecksum = await Dexie.waitFor(
          checksumLocalConflictBranch({
            ownerKey,
            gameId,
            slotId,
            branch: "server",
            value: conflict.server,
          }),
        );
        await this.db.conflicts.add(conflict);
        await this.db.saves.update(row.id, {
          syncState: "conflict",
          lastErrorCode: reason.toUpperCase(),
        });
        return conflict;
      },
    );
  }

  async retryMigrationFailure(
    input: VectorRetryMigrationFailureInput,
  ): Promise<{ save: VectorLocalSave; conflict: VectorLocalConflict }> {
    await this.assertActive(input.ownerKey);
    if (
      !/^[0-9a-f-]{36}$/i.test(input.conflictId) ||
      !Number.isSafeInteger(input.expectedConflictVersion) ||
      input.expectedConflictVersion <= 0 ||
      !Number.isSafeInteger(input.expectedAncestor.localRevision) ||
      input.expectedAncestor.localRevision <= 0 ||
      !vectorChecksumSchema.safeParse(input.expectedAncestor.checksum).success
    ) {
      throw new VectorPersistenceError("VECTOR_CONFLICT_INPUT_INVALID");
    }
    const parsedInput = vectorLocalSaveInputSchema.safeParse({
      gameId: input.gameId,
      slotId: input.slotId,
      gameVersion: input.gameVersion,
      saveSchemaVersion: input.saveSchemaVersion,
      deviceId: input.deviceId,
      seed: input.seed,
      state: input.state,
      ...(input.checkpointLabel === undefined ? {} : {
        checkpointLabel: input.checkpointLabel,
      }),
      ...(input.updatedAt === undefined ? {} : { updatedAt: input.updatedAt }),
    });
    if (!parsedInput.success) {
      throw new VectorPersistenceError("VECTOR_SAVE_INPUT_INVALID");
    }
    const validated = parsedInput.data;
    if (vectorJsonBytes(validated.state) > VECTOR_SAVE_MAX_STATE_BYTES) {
      throw new VectorPersistenceError("VECTOR_SAVE_TOO_LARGE");
    }
    const checksum = await checksumVectorState(validated.state);
    const id = saveId(input.ownerKey, validated.gameId, validated.slotId);
    const updatedAt = validated.updatedAt ?? nowIso();
    const resolvedAt = nowIso();

    try {
      return await this.db.transaction(
        "rw",
        this.db.meta,
        this.db.saves,
        this.db.conflicts,
        async () => {
          await this.assertActive(input.ownerKey);
          const currentRow = await this.db.conflicts.get(input.conflictId);
          if (!currentRow || currentRow.ownerKey !== input.ownerKey) {
            throw new VectorPersistenceError("VECTOR_CONFLICT_NOT_FOUND");
          }
          const conflict = normalizeConflict(input.ownerKey, currentRow);
          if (conflict.authority !== "local") {
            throw new VectorPersistenceError("VECTOR_CONFLICT_AUTHORITY_INVALID");
          }
          if (conflict.status !== "open") {
            throw new VectorPersistenceError("VECTOR_CONFLICT_ALREADY_RESOLVED");
          }
          if (
            conflict.reason !== "save_schema_newer" &&
            conflict.reason !== "save_migrator_missing" &&
            conflict.reason !== "save_migration_failed"
          ) {
            throw new VectorPersistenceError("VECTOR_CONFLICT_INPUT_INVALID");
          }
          if (
            conflict.conflictVersion !== input.expectedConflictVersion ||
            conflict.gameId !== validated.gameId ||
            conflict.slotId !== validated.slotId ||
            conflict.local.localRevision !== input.expectedAncestor.localRevision ||
            conflict.local.checksum !== input.expectedAncestor.checksum
          ) {
            throw new VectorPersistenceError("VECTOR_CONFLICT_VERSION_MISMATCH");
          }
          if (
            conflict.local.state === undefined ||
            !conflict.local.integrityChecksum ||
            await Dexie.waitFor(checksumLocalConflictBranch({
              ownerKey: input.ownerKey,
              gameId: conflict.gameId,
              slotId: conflict.slotId,
              branch: "local",
              value: conflict.local,
            })).catch(() => "") !== conflict.local.integrityChecksum ||
            await Dexie.waitFor(checksumVectorState(conflict.local.state)).catch(() => "") !==
              conflict.local.checksum
          ) {
            throw new VectorPersistenceError("VECTOR_CONFLICT_BRANCH_INVALID");
          }
          const current = await this.db.saves.get(id);
          if (
            !current ||
            current.localRevision !== input.expectedAncestor.localRevision ||
            current.checksum !== input.expectedAncestor.checksum ||
            current.gameVersion !== conflict.local.gameVersion ||
            current.saveSchemaVersion !== conflict.local.saveSchemaVersion ||
            current.seed !== conflict.local.seed ||
            current.updatedAt !== conflict.local.updatedAt ||
            !await Dexie.waitFor(this.verifyLocalSave(current))
          ) {
            throw new VectorPersistenceError("VECTOR_CONFLICT_VERSION_MISMATCH");
          }

          const save: VectorLocalSave = {
            id,
            ownerKey: input.ownerKey,
            gameId: validated.gameId,
            slotId: validated.slotId,
            gameVersion: validated.gameVersion,
            saveSchemaVersion: validated.saveSchemaVersion,
            localRevision: current.localRevision + 1,
            serverRevision: current.serverRevision,
            pendingIdempotencyKey: crypto.randomUUID(),
            deviceId: validated.deviceId,
            checksum,
            seed: validated.seed,
            state: validated.state,
            ...(validated.checkpointLabel
              ? { checkpointLabel: validated.checkpointLabel }
              : {}),
            updatedAt,
            syncState: input.ownerKey.startsWith("user:") ? "pending" : "local-only",
            lastErrorCode: null,
          };
          save.integrityChecksum = await Dexie.waitFor(checksumLocalSaveEnvelope(save));
          await this.db.saves.put(save);
          const resolved: VectorLocalConflict = {
            ...conflict,
            status: "resolved",
            resolution: "accept-local",
            conflictVersion: conflict.conflictVersion + 1,
            resolvedAt,
          };
          await this.db.conflicts.put(resolved);
          return { save, conflict: resolved };
        },
      );
    } catch (error) {
      if (isQuotaError(error)) throw new VectorPersistenceError("VECTOR_LOCAL_QUOTA_EXCEEDED");
      throw error;
    }
  }

  async listSaves(ownerKey: VectorOwnerKey, gameId?: VectorGameSlug): Promise<VectorLocalSave[]> {
    return (await this.listVerifiedSaves(ownerKey, gameId)).saves;
  }

  async enqueueEvent(
    ownerKey: VectorOwnerKey,
    gameId: VectorGameSlug,
    event: VectorSyncEvent,
  ): Promise<VectorLocalOutboxEvent> {
    await this.assertActive(ownerKey);
    const parsed = vectorSyncEventSchema.parse(event);
    const eventJson = canonicalVectorJson(parsed as unknown as Json);
    if (new TextEncoder().encode(eventJson).byteLength > VECTOR_EVENT_MAX_PAYLOAD_BYTES) {
      throw new VectorPersistenceError("VECTOR_EVENT_TOO_LARGE");
    }
    const payloadHash = await hashVectorPayload(parsed as unknown as Json);
    const now = nowIso();
    const row: VectorLocalOutboxEvent = {
      id: parsed.idempotencyKey,
      ownerKey,
      gameId,
      event: parsed,
      payloadHash,
      status: ownerKey.startsWith("user:") ? "pending" : "frozen",
      attemptCount: 0,
      lastErrorCode: null,
      createdAt: now,
      updatedAt: now,
    };
    try {
      return await this.db.transaction(
        "rw",
        this.db.meta,
        this.db.profiles,
        this.db.outbox,
        async () => {
        await this.assertActive(ownerKey);
        const existing = await this.db.outbox.get(parsed.idempotencyKey);
        if (existing) {
          if (
            existing.ownerKey !== ownerKey ||
            existing.gameId !== gameId ||
            existing.payloadHash !== payloadHash
          ) {
            throw new VectorPersistenceError("VECTOR_IDEMPOTENCY_REUSED");
          }
          return existing;
        }
        await this.db.outbox.add(row);
        if (
          parsed.kind === "score" ||
          parsed.kind === "achievement" ||
          parsed.kind === "counter"
        ) {
          const current = await this.db.profiles.get(ownerKey);
          const device = await this.db.meta.get(DEVICE_ID_META_KEY);
          const profile = normalizeProfile(current ?? {
            ownerKey,
            deviceId: typeof device?.value === "string" ? device.value : "vector-local",
            settings: {},
            settingClocks: {},
            unlocks: [],
            scores: {},
            counters: {},
            serverRevision: 0,
            syncState: ownerKey.startsWith("user:") ? "synced" : "local-only",
            updatedAt: now,
          });
          let updated: VectorLocalProfile;
          if (parsed.kind === "score") {
            const key = scoreKey({
              gameId,
              mode: parsed.payload.mode,
              challengeId: parsed.payload.challengeId,
            });
            updated = {
              ...profile,
              scores: {
                ...profile.scores,
                [key]: mergeVectorBestScore(
                  profile.scores[key] ?? null,
                  parsed.payload.value,
                ),
              },
              updatedAt: now,
            };
          } else if (parsed.kind === "achievement") {
            updated = {
              ...profile,
              unlocks: mergeVectorStringSet(profile.unlocks, [
                achievementKey(gameId, parsed.payload.achievementId),
              ]),
              updatedAt: now,
            };
          } else {
            const key = counterKey(gameId, parsed.payload.counterId);
            const next = (profile.counters[key] ?? 0) + parsed.payload.delta;
            if (!Number.isSafeInteger(next) || next > Number.MAX_SAFE_INTEGER) {
              throw new VectorPersistenceError("VECTOR_COUNTER_OVERFLOW");
            }
            updated = {
              ...profile,
              counters: {
                ...profile.counters,
                [key]: next,
              },
              updatedAt: now,
            };
          }
          assertProfileDocumentBytes(updated);
          await this.db.profiles.put(updated);
        }
        return row;
      },
      );
    } catch (error) {
      if (isQuotaError(error)) throw new VectorPersistenceError("VECTOR_LOCAL_QUOTA_EXCEEDED");
      throw error;
    }
  }

  private async verifiedOutboxIds(
    ownerKey: VectorOwnerKey,
    gameId: VectorGameSlug,
  ): Promise<Set<string>> {
    const candidates = (await this.listOutbox(ownerKey, gameId)).filter((event) => (
      (event.status === "pending" || event.status === "error") &&
      !outboxErrorIsTerminal(event.lastErrorCode)
    ));
    const verified = new Set<string>();
    const corrupt: string[] = [];
    for (const row of candidates) {
      const parsed = vectorSyncEventSchema.safeParse(row.event);
      let valid = parsed.success && (
        row.id === parsed.data.idempotencyKey &&
        row.ownerKey === ownerKey &&
        row.gameId === gameId
      );
      if (valid && parsed.success) {
        const bytes = new TextEncoder().encode(
          canonicalVectorJson(parsed.data as unknown as Json),
        ).byteLength;
        valid = bytes <= VECTOR_EVENT_MAX_PAYLOAD_BYTES && (
          await hashVectorPayload(parsed.data as unknown as Json) === row.payloadHash
        );
      }
      if (valid) verified.add(row.id);
      else corrupt.push(row.id);
    }
    if (corrupt.length > 0) {
      await this.db.transaction("rw", this.db.meta, this.db.outbox, async () => {
        await this.assertActive(ownerKey);
        for (const id of corrupt) {
          const current = await this.db.outbox.get(id);
          if (current?.ownerKey === ownerKey && current.gameId === gameId) {
            await this.db.outbox.update(id, {
              status: "error",
              lastErrorCode: "VECTOR_EVENT_CORRUPT",
              updatedAt: nowIso(),
            });
          }
        }
      });
    }
    return verified;
  }

  async createSyncSnapshot(
    ownerKey: VectorOwnerKey,
    gameId: VectorGameSlug,
    deviceId: string,
  ): Promise<VectorSyncSnapshot | null> {
    await this.assertActive(ownerKey);
    if (!ownerKey.startsWith("user:")) return null;
    const verifiedIds = new Set(
      (await this.listVerifiedSaves(ownerKey, gameId)).saves.map((save) => save.id),
    );
    const verifiedEventIds = await this.verifiedOutboxIds(ownerKey, gameId);
    const hasCorruptEvent = (await this.listOutbox(ownerKey, gameId)).some((event) => (
      event.lastErrorCode === "VECTOR_EVENT_CORRUPT"
    ));
    return this.db.transaction("rw", this.db.meta, this.db.saves, this.db.outbox, async () => {
      await this.assertActive(ownerKey);
      const saves = (await this.db.saves.where("[ownerKey+gameId]").equals([ownerKey, gameId]).toArray())
        .filter((save) => verifiedIds.has(save.id) && (
          save.syncState === "pending" || save.syncState === "error"
        ))
        .sort((left, right) => compareVectorText(left.updatedAt, right.updatedAt))
        .slice(0, 4);
      const events = (await this.db.outbox.where("[ownerKey+gameId+status]").anyOf(
        [ownerKey, gameId, "pending"],
        [ownerKey, gameId, "error"],
      ).toArray())
        .filter((event) => verifiedEventIds.has(event.id))
        .sort((left, right) => compareVectorText(left.createdAt, right.createdAt))
        .slice(0, 64);
      if (saves.length === 0 && events.length === 0) {
        if (hasCorruptEvent) throw new VectorPersistenceError("VECTOR_EVENT_CORRUPT");
        return null;
      }
      const now = nowIso();
      await this.db.outbox.bulkUpdate(events.map((event) => ({
        key: event.id,
        changes: {
          status: "sending",
          attemptCount: event.attemptCount + 1,
          updatedAt: now,
        },
      })));
      await this.db.saves.bulkUpdate(saves.map((save) => ({
        key: save.id,
        changes: { syncState: "syncing" },
      })));
      return {
        body: {
          gameId,
          deviceId,
          saves: saves.map((save) => ({
            idempotencyKey: save.pendingIdempotencyKey,
            slotId: save.slotId,
            gameVersion: save.gameVersion,
            saveSchemaVersion: save.saveSchemaVersion,
            expectedServerRevision: save.serverRevision,
            localRevision: save.localRevision,
            checksum: save.checksum,
            seed: save.seed,
            state: save.state,
            updatedAt: save.updatedAt,
          })),
          events: events.map((event) => event.event),
        },
        transmittedSaves: saves.map((save) => ({
          slotId: save.slotId,
          localRevision: save.localRevision,
          idempotencyKey: save.pendingIdempotencyKey,
        })),
        transmittedEvents: events.map((event) => ({
          idempotencyKey: event.id,
          kind: event.event.kind,
          localRevision: event.event.localRevision,
        })),
      };
    });
  }

  async markSyncFailed(snapshot: VectorSyncSnapshot, ownerKey: VectorOwnerKey, code: string): Promise<void> {
    await this.assertActive(ownerKey);
    await this.db.transaction("rw", this.db.meta, this.db.saves, this.db.outbox, async () => {
      await this.assertActive(ownerKey);
      for (const sent of snapshot.transmittedSaves) {
        const id = saveId(ownerKey, snapshot.body.gameId, sent.slotId);
        const current = await this.db.saves.get(id);
        if (current?.localRevision === sent.localRevision) {
          await this.db.saves.update(id, { syncState: "error", lastErrorCode: code });
        }
      }
      await this.db.outbox.bulkUpdate(snapshot.transmittedEvents.map((event) => ({
        key: event.idempotencyKey,
        changes: { status: "error", lastErrorCode: code, updatedAt: nowIso() },
      })));
    });
  }

  async applySyncResponse(
    ownerKey: VectorOwnerKey,
    snapshot: VectorSyncSnapshot,
    response: VectorSyncResponse,
  ): Promise<void> {
    await this.assertActive(ownerKey);
    const resultKeys = new Set<string>();
    for (const result of response.results) {
      if (resultKeys.has(result.idempotencyKey)) {
        throw new VectorPersistenceError("VECTOR_SYNC_RESPONSE_DUPLICATE_RESULT");
      }
      resultKeys.add(result.idempotencyKey);
    }
    if (
      response.saves.some((save) => save.gameId !== snapshot.body.gameId) ||
      response.conflicts.some((conflict) => conflict.gameId !== snapshot.body.gameId)
    ) {
      throw new VectorPersistenceError("VECTOR_SYNC_RESPONSE_SCOPE_INVALID");
    }
    for (const save of response.saves) await this.assertCloudSavePayload(save);
    for (const conflict of response.conflicts) {
      await this.assertCloudConflictPayload(conflict);
    }
    const authoritativeCounterResultIds = new Set(response.results.flatMap((result) => (
      result.kind === "counter" &&
      result.authoritativeValue !== undefined &&
      snapshot.transmittedEvents.some((event) => (
        event.idempotencyKey === result.idempotencyKey &&
        event.kind === result.kind &&
        event.localRevision === result.localRevision
      )) ? [result.idempotencyKey] : []
    )));
    await this.db.transaction(
      "rw",
      this.db.meta,
      this.db.profiles,
      this.db.saves,
      this.db.outbox,
      this.db.conflicts,
      async () => {
        await this.assertActive(ownerKey);
        const acknowledgedSaves = new Set<string>();
        const acknowledgedEvents = new Set<string>();
        let acknowledgedSettingsRevision: number | null = null;
        for (const result of response.results) {
          if (result.kind === "save" && result.slotId && result.localRevision !== null) {
            const transmitted = snapshot.transmittedSaves.find((save) => (
              save.idempotencyKey === result.idempotencyKey &&
              save.slotId === result.slotId &&
              save.localRevision === result.localRevision
            ));
            if (!transmitted) continue;
            acknowledgedSaves.add(transmitted.idempotencyKey);
            const id = saveId(ownerKey, snapshot.body.gameId, result.slotId);
            const current = await this.db.saves.get(id);
            if (!current || current.localRevision !== result.localRevision) continue;
            if (result.status === "applied" || result.status === "duplicate") {
              await this.db.saves.update(id, {
                serverRevision: Math.max(
                  current.serverRevision,
                  result.serverRevision ?? current.serverRevision,
                ),
                syncState: "synced",
                lastErrorCode: null,
              });
            } else if (result.status === "conflict") {
              await this.db.saves.update(id, {
                syncState: "conflict",
                lastErrorCode: result.code,
              });
            } else {
              await this.db.saves.update(id, {
                syncState: "error",
                lastErrorCode: result.code,
              });
            }
          } else {
            const transmitted = snapshot.transmittedEvents.find((event) => (
              event.idempotencyKey === result.idempotencyKey &&
              event.kind === result.kind &&
              event.localRevision === result.localRevision
            ));
            if (!transmitted) continue;
            acknowledgedEvents.add(transmitted.idempotencyKey);
            const acknowledged = await this.db.outbox.get(result.idempotencyKey);
            if (
              acknowledged?.ownerKey === ownerKey &&
              acknowledged.event.kind === "counter" &&
              result.authoritativeValue !== undefined
            ) {
              const profile = await this.db.profiles.get(ownerKey);
              if (profile) {
                const current = normalizeProfile(profile);
                const acknowledgedCounterId = acknowledged.event.payload.counterId;
                const key = counterKey(
                  snapshot.body.gameId,
                  acknowledgedCounterId,
                );
                const authoritativeValue = Math.max(...response.results.flatMap((candidate) => {
                  if (candidate.kind !== "counter" || candidate.authoritativeValue === undefined) {
                    return [];
                  }
                  const event = snapshot.body.events.find((sent) => (
                    sent.idempotencyKey === candidate.idempotencyKey &&
                    sent.kind === "counter" &&
                    sent.localRevision === candidate.localRevision
                  ));
                  return event?.kind === "counter" &&
                    event.payload.counterId === acknowledgedCounterId
                    ? [candidate.authoritativeValue]
                    : [];
                }));
                const outstanding = await this.db.outbox
                  .where("ownerKey")
                  .equals(ownerKey)
                  .and((event) => (
                    event.gameId === snapshot.body.gameId &&
                    event.status !== "frozen" &&
                    !outboxErrorIsTerminal(event.lastErrorCode) &&
                    !authoritativeCounterResultIds.has(event.id) &&
                    event.event.kind === "counter" &&
                    event.event.payload.counterId === acknowledgedCounterId
                  ))
                  .count();
                if (outstanding === 0) {
                  const updated: VectorLocalProfile = {
                    ...current,
                    counters: {
                      ...current.counters,
                      [key]: authoritativeValue,
                    },
                    updatedAt: response.serverTime,
                  };
                  assertProfileDocumentBytes(updated);
                  await this.db.profiles.put(updated);
                }
              }
            }
            if (
              acknowledged?.ownerKey === ownerKey &&
              acknowledged.event.kind === "settings" &&
              result.status === "rejected" &&
              result.code === "VECTOR_SETTING_CLOCK_FUTURE"
            ) {
              const profile = await this.db.profiles.get(ownerKey);
              if (profile) {
                const current = normalizeProfile(profile);
                const settings = { ...current.settings };
                const settingClocks = { ...current.settingClocks };
                for (const [key, rejectedClock] of Object.entries(
                  acknowledged.event.payload.clocks,
                )) {
                  const currentClock = settingClocks[key];
                  if (
                    currentClock?.at === rejectedClock.at &&
                    currentClock.deviceId === rejectedClock.deviceId
                  ) {
                    delete settings[key];
                    delete settingClocks[key];
                  }
                }
                const updated: VectorLocalProfile = {
                  ...current,
                  settings,
                  settingClocks,
                  syncState: "error",
                  updatedAt: response.serverTime,
                };
                assertProfileDocumentBytes(updated);
                await this.db.profiles.put(updated);
              }
            }
            if (result.status === "applied" || result.status === "duplicate") {
              if (acknowledged?.ownerKey === ownerKey) {
                const event = acknowledged.event;
                if (event.kind === "score" || event.kind === "achievement") {
                  const current = normalizeProfile((await this.db.profiles.get(ownerKey)) ?? {
                    ownerKey,
                    deviceId: snapshot.body.deviceId,
                    settings: {},
                    settingClocks: {},
                    unlocks: [],
                    scores: {},
                    counters: {},
                    serverRevision: 0,
                    syncState: "synced",
                    updatedAt: response.serverTime,
                  });
                  if (event.kind === "score") {
                    const key = scoreKey({
                      gameId: snapshot.body.gameId,
                      mode: event.payload.mode,
                      challengeId: event.payload.challengeId,
                    });
                    const updated: VectorLocalProfile = {
                      ...current,
                      scores: {
                        ...current.scores,
                        [key]: mergeVectorBestScore(
                          current.scores[key] ?? null,
                          event.payload.value,
                        ),
                      },
                      updatedAt: response.serverTime,
                    };
                    assertProfileDocumentBytes(updated);
                    await this.db.profiles.put(updated);
                  } else if (event.kind === "achievement") {
                    const updated: VectorLocalProfile = {
                      ...current,
                      unlocks: mergeVectorStringSet(current.unlocks, [
                        achievementKey(snapshot.body.gameId, event.payload.achievementId),
                      ]),
                      updatedAt: response.serverTime,
                    };
                    assertProfileDocumentBytes(updated);
                    await this.db.profiles.put(updated);
                  }
                }
              }
              await this.db.outbox.delete(result.idempotencyKey);
              if (result.kind === "settings") {
                acknowledgedSettingsRevision = Math.max(
                  acknowledgedSettingsRevision ?? 0,
                  result.serverRevision ?? 0,
                );
              }
            } else {
              await this.db.outbox.update(result.idempotencyKey, {
                status: "error",
                lastErrorCode: result.code,
                updatedAt: nowIso(),
              });
            }
          }
        }
        for (const sent of snapshot.transmittedSaves) {
          if (acknowledgedSaves.has(sent.idempotencyKey)) continue;
          const id = saveId(ownerKey, snapshot.body.gameId, sent.slotId);
          const current = await this.db.saves.get(id);
          if (current?.localRevision === sent.localRevision && current.syncState === "syncing") {
            await this.db.saves.update(id, {
              syncState: "error",
              lastErrorCode: "VECTOR_SYNC_RESPONSE_INCOMPLETE",
            });
          }
        }
        await this.db.outbox.bulkUpdate(snapshot.transmittedEvents
          .filter((event) => !acknowledgedEvents.has(event.idempotencyKey))
          .map((event) => ({
            key: event.idempotencyKey,
            changes: {
              status: "error",
              lastErrorCode: "VECTOR_SYNC_RESPONSE_INCOMPLETE",
              updatedAt: nowIso(),
            },
          })));
        if (acknowledgedSettingsRevision !== null) {
          const pendingSettings = await this.db.outbox
            .where("ownerKey")
            .equals(ownerKey)
            .and((event) => (
              event.event.kind === "settings" &&
              event.status !== "frozen" &&
              !outboxErrorIsTerminal(event.lastErrorCode)
            ))
            .count();
          if (pendingSettings === 0) {
            const profile = await this.db.profiles.get(ownerKey);
            if (profile) {
              await this.db.profiles.update(ownerKey, {
                serverRevision: Math.max(
                  profile.serverRevision,
                  acknowledgedSettingsRevision,
                ),
                syncState: "synced",
                updatedAt: nowIso(),
              });
            }
          }
        }
        const incomingConflictIds = new Set(response.conflicts.map((conflict) => conflict.id));
        if (!response.truncated.conflicts && !response.truncated.saves) {
          const missing = await this.db.conflicts
            .where("ownerKey")
            .equals(ownerKey)
            .and((conflict) => (
              inferConflictAuthority(conflict) === "cloud" &&
              conflict.gameId === snapshot.body.gameId &&
              conflict.status === "open" &&
              !incomingConflictIds.has(conflict.id)
            ))
            .toArray();
          for (const conflict of missing) {
            await this.db.conflicts.put({
              ...normalizeConflict(ownerKey, conflict),
              status: "resolved",
              conflictVersion: conflict.conflictVersion + 1,
              resolvedAt: response.serverTime,
            });
            const id = saveId(ownerKey, conflict.gameId, conflict.slotId);
            const current = await this.db.saves.get(id);
            if (!current) continue;
            const unchanged = (
              current.localRevision === conflict.local.localRevision &&
              current.checksum === conflict.local.checksum
            );
            const returned = response.saves.find((save) => save.slotId === conflict.slotId);
            if (unchanged && returned) {
              await this.db.saves.update(id, { syncState: "synced", lastErrorCode: null });
            } else if (unchanged) {
              await this.db.saves.delete(id);
            } else if (!returned) {
              await this.db.saves.update(id, {
                serverRevision: 0,
                syncState: "pending",
                lastErrorCode: null,
              });
            }
          }
        }
        for (const conflict of response.conflicts) {
          await this.db.conflicts.put(cloudConflictToLocal(ownerKey, conflict));
        }
        for (const save of response.saves) {
          await this.mergeCloudSave(ownerKey, save);
        }
      },
    );
  }

  async listConflicts(
    ownerKey: VectorOwnerKey,
    gameId?: VectorGameSlug,
  ): Promise<VectorLocalConflict[]> {
    await this.assertActive(ownerKey);
    const conflicts = await this.db.transaction("r", this.db.meta, this.db.conflicts, async () => {
      await this.assertActive(ownerKey);
      return this.db.conflicts.where("ownerKey").equals(ownerKey).toArray();
    });
    return conflicts
      .filter((conflict) => !gameId || conflict.gameId === gameId)
      .map((conflict) => normalizeConflict(ownerKey, conflict));
  }

  async resolveLocalConflict(
    ownerKey: VectorOwnerKey,
    conflictId: string,
    resolution: VectorConflictResolution["resolution"],
    targetSlotId?: string,
  ): Promise<VectorLocalConflict> {
    await this.assertActive(ownerKey);
    if (!/^[0-9a-f-]{36}$/i.test(conflictId)) {
      throw new VectorPersistenceError("VECTOR_CONFLICT_INPUT_INVALID");
    }
    if (
      (resolution === "fork-local" && targetSlotId === undefined) ||
      (resolution !== "fork-local" && targetSlotId !== undefined)
    ) {
      throw new VectorPersistenceError("VECTOR_CONFLICT_TARGET_INVALID");
    }
    const parsedTarget = targetSlotId === undefined
      ? null
      : vectorSlotIdSchema.safeParse(targetSlotId);
    if (parsedTarget && !parsedTarget.success) {
      throw new VectorPersistenceError("VECTOR_CONFLICT_TARGET_INVALID");
    }

    const initialRow = await this.db.transaction(
      "r",
      this.db.meta,
      this.db.conflicts,
      async () => {
        await this.assertActive(ownerKey);
        return this.db.conflicts.get(conflictId);
      },
    );
    if (!initialRow || initialRow.ownerKey !== ownerKey) {
      throw new VectorPersistenceError("VECTOR_CONFLICT_NOT_FOUND");
    }
    const initial = normalizeConflict(ownerKey, initialRow);
    if (initial.authority !== "local") {
      throw new VectorPersistenceError("VECTOR_CONFLICT_AUTHORITY_INVALID");
    }
    if (initial.status !== "open") {
      throw new VectorPersistenceError("VECTOR_CONFLICT_ALREADY_RESOLVED");
    }
    if (parsedTarget?.success && parsedTarget.data === initial.slotId) {
      throw new VectorPersistenceError("VECTOR_CONFLICT_TARGET_INVALID");
    }

    const localIntegrityValid = !initial.local.integrityChecksum || (
      await checksumLocalConflictBranch({
        ownerKey,
        gameId: initial.gameId,
        slotId: initial.slotId,
        branch: "local",
        value: initial.local,
      }).catch(() => "") === initial.local.integrityChecksum
    );
    const localUsable = !localConflictBranchIsUnusable(initial.reason) && localIntegrityValid && (
      initial.local.state !== undefined &&
      vectorJsonBytes(initial.local.state) <= VECTOR_SAVE_MAX_STATE_BYTES &&
      await checksumVectorState(initial.local.state).catch(() => "") === initial.local.checksum
    );
    if ((resolution === "accept-local" || resolution === "fork-local") && !localUsable) {
      throw new VectorPersistenceError("VECTOR_CONFLICT_BRANCH_INVALID");
    }
    const serverIntegrityValid = !initial.server.integrityChecksum || (
      await checksumLocalConflictBranch({
        ownerKey,
        gameId: initial.gameId,
        slotId: initial.slotId,
        branch: "server",
        value: initial.server,
      }).catch(() => "") === initial.server.integrityChecksum
    );
    const serverDeletes = serverIntegrityValid && (
      initial.server.state === undefined && initial.server.serverRevision === 0
    );
    const serverUsable = serverIntegrityValid && initial.server.state !== undefined && (
      initial.server.gameVersion !== null &&
      initial.server.saveSchemaVersion !== null &&
      initial.server.checksum !== null &&
      initial.server.updatedAt !== null &&
      vectorJsonBytes(initial.server.state) <= VECTOR_SAVE_MAX_STATE_BYTES &&
      await checksumVectorState(initial.server.state).catch(() => "") === initial.server.checksum
    );
    if ((resolution === "accept-server" || resolution === "fork-local") && (
      !serverUsable && !serverDeletes
    )) {
      throw new VectorPersistenceError("VECTOR_CONFLICT_BRANCH_INVALID");
    }

    const resolvedAt = nowIso();
    try {
      return await this.db.transaction(
        "rw",
        this.db.meta,
        this.db.profiles,
        this.db.saves,
        this.db.conflicts,
        async () => {
          await this.assertActive(ownerKey);
          const currentRow = await this.db.conflicts.get(conflictId);
          if (!currentRow || currentRow.ownerKey !== ownerKey) {
            throw new VectorPersistenceError("VECTOR_CONFLICT_NOT_FOUND");
          }
          const conflict = normalizeConflict(ownerKey, currentRow);
          if (conflict.authority !== "local") {
            throw new VectorPersistenceError("VECTOR_CONFLICT_AUTHORITY_INVALID");
          }
          if (conflict.status !== "open") {
            throw new VectorPersistenceError("VECTOR_CONFLICT_ALREADY_RESOLVED");
          }
          if (conflict.conflictVersion !== initial.conflictVersion) {
            throw new VectorPersistenceError("VECTOR_CONFLICT_VERSION_MISMATCH");
          }
          const originalId = saveId(ownerKey, conflict.gameId, conflict.slotId);
          const currentSave = await this.db.saves.get(originalId);
          const isLocalConcurrentWrite = conflict.reason === "local_concurrent_write";
          if (isLocalConcurrentWrite) {
            if (
              conflict.local.integrityChecksum !== initial.local.integrityChecksum ||
              conflict.server.integrityChecksum !== initial.server.integrityChecksum ||
              conflict.expectedAncestorLocalRevision !== initial.expectedAncestorLocalRevision ||
              conflict.expectedAncestorChecksum !== initial.expectedAncestorChecksum ||
              conflict.currentLocalRevision !== initial.currentLocalRevision ||
              conflict.currentIntegrityChecksum !== initial.currentIntegrityChecksum
            ) {
              throw new VectorPersistenceError("VECTOR_CONFLICT_VERSION_MISMATCH");
            }
            const expectedCurrentMissing = conflict.currentLocalRevision === null &&
              conflict.currentIntegrityChecksum === null;
            if (expectedCurrentMissing ? currentSave !== undefined : (
              !currentSave ||
              conflict.currentLocalRevision === undefined ||
              conflict.currentIntegrityChecksum === undefined ||
              currentSave.localRevision !== conflict.currentLocalRevision ||
              currentSave.integrityChecksum !== conflict.currentIntegrityChecksum ||
              currentSave.gameVersion !== initial.server.gameVersion ||
              currentSave.saveSchemaVersion !== initial.server.saveSchemaVersion ||
              currentSave.checksum !== initial.server.checksum ||
              currentSave.seed !== initial.server.seed ||
              currentSave.updatedAt !== initial.server.updatedAt ||
              !await Dexie.waitFor(this.verifyLocalSave(currentSave))
            )) {
              throw new VectorPersistenceError("VECTOR_CONFLICT_VERSION_MISMATCH");
            }
          }
          const profile = await this.db.profiles.get(ownerKey);
          const deviceId = currentSave?.deviceId ?? profile?.deviceId ?? (
            ownerKey.startsWith("anonymous:") ? ownerKey.slice("anonymous:".length) : null
          );
          const requireDeviceId = (): string => {
            if (!deviceId) throw new VectorPersistenceError("VECTOR_CONFLICT_BRANCH_INVALID");
            return deviceId;
          };
          const slotCount = await this.db.saves
            .where("[ownerKey+gameId]")
            .equals([ownerKey, conflict.gameId])
            .count();
          const recreatesOriginal = !currentSave && (
            resolution === "accept-local" || serverUsable
          );
          if (resolution !== "fork-local" && recreatesOriginal && (
            slotCount >= VECTOR_MAX_SAVE_SLOTS
          )) {
            throw new VectorPersistenceError("VECTOR_SAVE_SLOT_LIMIT");
          }

          const writeLocalBranch = async (slotId: string, isFork: boolean) => {
            if (initial.local.state === undefined) {
              throw new VectorPersistenceError("VECTOR_CONFLICT_BRANCH_INVALID");
            }
            const id = saveId(ownerKey, conflict.gameId, slotId);
            const prior = isFork ? null : await this.db.saves.get(id);
            const branch: VectorLocalSave = {
              id,
              ownerKey,
              gameId: conflict.gameId,
              slotId,
              gameVersion: initial.local.gameVersion,
              saveSchemaVersion: initial.local.saveSchemaVersion,
              localRevision: isFork
                ? 1
                : Math.max(prior?.localRevision ?? 0, initial.local.localRevision) + 1,
              serverRevision: isFork
                ? 0
                : (prior?.serverRevision ?? initial.server.serverRevision),
              pendingIdempotencyKey: crypto.randomUUID(),
              deviceId: requireDeviceId(),
              checksum: initial.local.checksum,
              seed: initial.local.seed,
              state: initial.local.state,
              ...(initial.local.checkpointLabel !== undefined
                ? (initial.local.checkpointLabel
                    ? { checkpointLabel: initial.local.checkpointLabel }
                    : {})
                : (prior?.checkpointLabel
                    ? { checkpointLabel: prior.checkpointLabel }
                    : {})),
              updatedAt: resolvedAt,
              syncState: ownerKey.startsWith("user:") ? "pending" : "local-only",
              lastErrorCode: null,
            };
            branch.integrityChecksum = await Dexie.waitFor(
              checksumLocalSaveEnvelope(branch),
            );
            await this.db.saves.put(branch);
          };
          const applyServerBranch = async () => {
            if (isLocalConcurrentWrite) {
              if (!currentSave) return;
              await this.db.saves.update(originalId, {
                syncState: ownerKey.startsWith("user:") ? "pending" : "local-only",
                lastErrorCode: null,
              });
              return;
            }
            if (serverDeletes) {
              await this.db.saves.delete(originalId);
              return;
            }
            if (
              initial.server.state === undefined ||
              initial.server.gameVersion === null ||
              initial.server.saveSchemaVersion === null ||
              initial.server.checksum === null ||
              initial.server.updatedAt === null
            ) {
              throw new VectorPersistenceError("VECTOR_CONFLICT_BRANCH_INVALID");
            }
            const branch: VectorLocalSave = {
              id: originalId,
              ownerKey,
              gameId: conflict.gameId,
              slotId: conflict.slotId,
              gameVersion: initial.server.gameVersion,
              saveSchemaVersion: initial.server.saveSchemaVersion,
              localRevision: Math.max(
                currentSave?.localRevision ?? 0,
                initial.local.localRevision,
              ),
              serverRevision: initial.server.serverRevision,
              pendingIdempotencyKey: crypto.randomUUID(),
              deviceId: requireDeviceId(),
              checksum: initial.server.checksum,
              seed: initial.server.seed,
              state: initial.server.state,
              ...(currentSave?.checkpointLabel
                ? { checkpointLabel: currentSave.checkpointLabel }
                : {}),
              updatedAt: initial.server.updatedAt,
              syncState: ownerKey.startsWith("user:") ? "synced" : "local-only",
              lastErrorCode: null,
            };
            branch.integrityChecksum = await Dexie.waitFor(
              checksumLocalSaveEnvelope(branch),
            );
            await this.db.saves.put(branch);
          };

          if (resolution === "accept-local") {
            await writeLocalBranch(conflict.slotId, false);
          } else if (resolution === "accept-server") {
            await applyServerBranch();
          } else {
            const target = parsedTarget?.success ? parsedTarget.data : null;
            if (!target) throw new VectorPersistenceError("VECTOR_CONFLICT_TARGET_INVALID");
            const targetId = saveId(ownerKey, conflict.gameId, target);
            if (await this.db.saves.get(targetId)) {
              throw new VectorPersistenceError("VECTOR_CONFLICT_TARGET_EXISTS");
            }
            const originalDelta = serverDeletes
              ? (currentSave ? -1 : 0)
              : (currentSave ? 0 : 1);
            const projected = slotCount + originalDelta + 1;
            if (projected > VECTOR_MAX_SAVE_SLOTS) {
              throw new VectorPersistenceError("VECTOR_SAVE_SLOT_LIMIT");
            }
            await applyServerBranch();
            await writeLocalBranch(target, true);
          }
          const resolved: VectorLocalConflict = {
            ...conflict,
            status: "resolved",
            resolution,
            conflictVersion: conflict.conflictVersion + 1,
            resolvedAt,
          };
          await this.db.conflicts.put(resolved);
          return resolved;
        },
      );
    } catch (error) {
      if (isQuotaError(error)) throw new VectorPersistenceError("VECTOR_LOCAL_QUOTA_EXCEEDED");
      throw error;
    }
  }

  async applyCloudConflictResolution(
    ownerKey: VectorOwnerKey,
    conflict: VectorCloudConflict,
    saves: VectorCloudSave[],
    expected: {
      resolution: VectorConflictResolution["resolution"];
      targetSlotId?: string;
      resolvedBranch: VectorResolvedBranch;
    },
  ): Promise<VectorLocalConflict> {
    await this.assertActive(ownerKey);
    const expectedTarget = expected.targetSlotId === undefined
      ? null
      : vectorSlotIdSchema.safeParse(expected.targetSlotId);
    if (
      conflict.status !== "resolved" ||
      conflict.resolution === null ||
      conflict.resolution !== expected.resolution ||
      (expected.resolution === "fork-local" && !expectedTarget?.success) ||
      (expected.resolution !== "fork-local" && expected.targetSlotId !== undefined) ||
      (expectedTarget?.success && expectedTarget.data === conflict.slotId)
    ) {
      throw new VectorPersistenceError("VECTOR_CONFLICT_INPUT_INVALID");
    }
    const allowedSlots = new Set([conflict.slotId]);
    if (expectedTarget?.success) allowedSlots.add(expectedTarget.data);
    if (saves.some((save) => (
      save.gameId !== conflict.gameId ||
      !allowedSlots.has(save.slotId) ||
      save.state === undefined ||
      save.deletedAt !== null
    )) || new Set(saves.map((save) => save.slotId)).size !== saves.length) {
      throw new VectorPersistenceError("VECTOR_SYNC_RESPONSE_SCOPE_INVALID");
    }
    if (!expected.resolvedBranch || !resolvedBranchMatchesConflict({
      conflict,
      resolution: expected.resolution,
      targetSlotId: expected.targetSlotId,
      branch: expected.resolvedBranch,
    })) {
      throw new VectorPersistenceError("VECTOR_CONFLICT_BRANCH_INVALID");
    }
    await this.assertCloudConflictPayload(conflict);
    for (const save of saves) await this.assertCloudSavePayload(save);
    return this.db.transaction(
      "rw",
      this.db.meta,
      this.db.saves,
      this.db.conflicts,
      async () => {
        await this.assertActive(ownerKey);
        const storedRow = await this.db.conflicts.get(conflict.id);
        if (!storedRow || storedRow.ownerKey !== ownerKey) {
          throw new VectorPersistenceError("VECTOR_CONFLICT_NOT_FOUND");
        }
        const stored = normalizeConflict(ownerKey, storedRow);
        if (
          stored.authority !== "cloud" ||
          stored.gameId !== conflict.gameId ||
          stored.slotId !== conflict.slotId ||
          stored.reason !== conflict.reason ||
          stored.local.localRevision !== conflict.local.localRevision ||
          stored.local.checksum !== conflict.local.checksum ||
          stored.local.gameVersion !== conflict.local.gameVersion ||
          stored.local.saveSchemaVersion !== conflict.local.saveSchemaVersion ||
          stored.local.seed !== conflict.local.seed ||
          stored.server.serverRevision !== conflict.server.serverRevision ||
          stored.server.checksum !== conflict.server.checksum ||
          stored.server.gameVersion !== conflict.server.gameVersion ||
          stored.server.saveSchemaVersion !== conflict.server.saveSchemaVersion ||
          stored.server.seed !== conflict.server.seed
        ) {
          throw new VectorPersistenceError("VECTOR_CONFLICT_AUTHORITY_INVALID");
        }
        const firstApplication = stored.status === "open" && (
          conflict.conflictVersion === stored.conflictVersion + 1
        );
        const idempotentReplay = stored.status === "resolved" && (
          conflict.conflictVersion === stored.conflictVersion &&
          stored.resolution === conflict.resolution
        );
        if (!firstApplication && !idempotentReplay) {
          throw new VectorPersistenceError("VECTOR_CONFLICT_VERSION_MISMATCH");
        }
        const resolved = cloudConflictToLocal(ownerKey, conflict);
        await this.db.conflicts.put(resolved);

        const originalId = saveId(ownerKey, stored.gameId, stored.slotId);
        const current = await this.db.saves.get(originalId);
        const unchanged = Boolean(current && (
          current.localRevision === stored.local.localRevision &&
          current.checksum === stored.local.checksum
        ));
        const returnedOriginal = saves.find((save) => save.slotId === stored.slotId);
        if (unchanged && returnedOriginal) {
          await this.db.saves.update(originalId, {
            syncState: "synced",
            lastErrorCode: null,
          });
        } else if (unchanged && !returnedOriginal) {
          await this.db.saves.delete(originalId);
        } else if (current && !returnedOriginal && stored.server.serverRevision === 0) {
          await this.db.saves.update(originalId, {
            serverRevision: 0,
            syncState: ownerKey.startsWith("user:") ? "pending" : "local-only",
            lastErrorCode: null,
          });
        }
        for (const save of saves) await this.mergeCloudSave(ownerKey, save);
        return resolved;
      },
    );
  }

  async listOutbox(
    ownerKey: VectorOwnerKey,
    gameId?: VectorGameSlug,
  ): Promise<VectorLocalOutboxEvent[]> {
    await this.assertActive(ownerKey);
    const events = await this.db.transaction("r", this.db.meta, this.db.outbox, async () => {
      await this.assertActive(ownerKey);
      return this.db.outbox.where("ownerKey").equals(ownerKey).toArray();
    });
    return events
      .filter((event) => !gameId || event.gameId === gameId)
      .sort((left, right) => compareVectorText(left.createdAt, right.createdAt));
  }

  async countPendingSyncWork(
    ownerKey: VectorOwnerKey,
    gameId: VectorGameSlug,
  ): Promise<number> {
    await this.assertActive(ownerKey);
    return this.db.transaction(
      "r",
      this.db.meta,
      this.db.saves,
      this.db.outbox,
      async () => {
        await this.assertActive(ownerKey);
        const saves = await this.db.saves
          .where("[ownerKey+gameId]")
          .equals([ownerKey, gameId])
          .and((save) => save.syncState === "pending" || save.syncState === "error")
          .count();
        const events = await this.db.outbox
          .where("ownerKey")
          .equals(ownerKey)
          .and((event) => (
            event.gameId === gameId &&
            (event.status === "pending" || event.status === "error") &&
            !outboxErrorIsTerminal(event.lastErrorCode)
          ))
          .count();
        return saves + events;
      },
    );
  }

  async listInstalls(deviceId: string): Promise<VectorLocalInstall[]> {
    return this.db.installs.where("deviceId").equals(deviceId).sortBy("updatedAt");
  }

  async previewAnonymousAdoption(
    anonymousOwner: VectorOwnerKey,
    userOwner: VectorOwnerKey,
  ): Promise<{ saves: number; events: number; collisions: number }> {
    if (!anonymousOwner.startsWith("anonymous:") || !userOwner.startsWith("user:")) {
      throw new VectorPersistenceError("VECTOR_OWNER_INVALID");
    }
    await this.assertActive(userOwner);
    const { anonymousSaves, userSaves, events } = await this.db.transaction(
      "r",
      this.db.meta,
      this.db.saves,
      this.db.outbox,
      async () => {
        await this.assertActive(userOwner);
        return {
          anonymousSaves: await this.db.saves.where("ownerKey").equals(anonymousOwner).toArray(),
          userSaves: await this.db.saves.where("ownerKey").equals(userOwner).toArray(),
          events: await this.db.outbox.where("ownerKey").equals(anonymousOwner).count(),
        };
      },
    );
    const userKeys = new Set(userSaves.map((save) => `${save.gameId}:${save.slotId}`));
    return {
      saves: anonymousSaves.length,
      events,
      collisions: anonymousSaves.filter((save) => userKeys.has(`${save.gameId}:${save.slotId}`)).length,
    };
  }

  async adoptAnonymousData(
    anonymousOwner: VectorOwnerKey,
    userOwner: VectorOwnerKey,
    deviceId: string,
  ): Promise<{ adoptedSaves: number; conflicts: number; adoptedEvents: number }> {
    await this.assertActive(userOwner);
    if (!anonymousOwner.startsWith("anonymous:") || !userOwner.startsWith("user:")) {
      throw new VectorPersistenceError("VECTOR_OWNER_INVALID");
    }
    return this.db.transaction(
      "rw",
      this.db.meta,
      this.db.saves,
      this.db.outbox,
      this.db.conflicts,
      async () => {
        await this.assertActive(userOwner);
        const saves = await this.db.saves.where("ownerKey").equals(anonymousOwner).toArray();
        const events = await this.db.outbox.where("ownerKey").equals(anonymousOwner).toArray();
        const userSaves = await this.db.saves.where("ownerKey").equals(userOwner).toArray();
        const projectedSlots = new Map<VectorGameSlug, number>();
        for (const save of userSaves) {
          projectedSlots.set(save.gameId, (projectedSlots.get(save.gameId) ?? 0) + 1);
        }
        const userKeys = new Set(userSaves.map((save) => `${save.gameId}:${save.slotId}`));
        for (const save of [...saves, ...userSaves]) {
          if (!await Dexie.waitFor(this.verifyLocalSave(save))) {
            throw new VectorPersistenceError("VECTOR_SAVE_CORRUPT");
          }
        }
        for (const source of saves) {
          const key = `${source.gameId}:${source.slotId}`;
          if (userKeys.has(key)) continue;
          const nextCount = (projectedSlots.get(source.gameId) ?? 0) + 1;
          if (nextCount > VECTOR_MAX_SAVE_SLOTS) {
            throw new VectorPersistenceError("VECTOR_SAVE_SLOT_LIMIT");
          }
          projectedSlots.set(source.gameId, nextCount);
          userKeys.add(key);
        }
        let adoptedSaves = 0;
        let conflicts = 0;
        for (const source of saves) {
          const targetId = saveId(userOwner, source.gameId, source.slotId);
          const target = await this.db.saves.get(targetId);
          if (!target) {
            const adopted: VectorLocalSave = {
              ...source,
              id: targetId,
              ownerKey: userOwner,
              deviceId,
              localRevision: 1,
              serverRevision: 0,
              pendingIdempotencyKey: crypto.randomUUID(),
              syncState: "pending",
              lastErrorCode: null,
            };
            adopted.integrityChecksum = await Dexie.waitFor(
              checksumLocalSaveEnvelope(adopted),
            );
            await this.db.saves.put(adopted);
            adoptedSaves += 1;
            await this.db.saves.delete(source.id);
            continue;
          }
          if (
            target.checksum !== source.checksum ||
            target.gameVersion !== source.gameVersion ||
            target.saveSchemaVersion !== source.saveSchemaVersion ||
            target.seed !== source.seed
          ) {
            const conflict: VectorLocalConflict = {
              id: crypto.randomUUID(),
              ownerKey: userOwner,
              authority: "local",
              gameId: source.gameId,
              slotId: source.slotId,
              reason: "anonymous_adoption_collision",
              conflictVersion: 1,
              status: "open",
              resolution: null,
              local: {
                localRevision: source.localRevision,
                gameVersion: source.gameVersion,
                saveSchemaVersion: source.saveSchemaVersion,
                checksum: source.checksum,
                seed: source.seed,
                state: source.state,
                checkpointLabel: source.checkpointLabel ?? null,
                updatedAt: source.updatedAt,
              },
              server: {
                serverRevision: target.serverRevision,
                gameVersion: target.gameVersion,
                saveSchemaVersion: target.saveSchemaVersion,
                checksum: target.checksum,
                seed: target.seed,
                state: target.state,
                updatedAt: target.updatedAt,
              },
              createdAt: nowIso(),
              resolvedAt: null,
            };
            conflict.local.integrityChecksum = await Dexie.waitFor(
              checksumLocalConflictBranch({
                ownerKey: userOwner,
                gameId: conflict.gameId,
                slotId: conflict.slotId,
                branch: "local",
                value: conflict.local,
              }),
            );
            conflict.server.integrityChecksum = await Dexie.waitFor(
              checksumLocalConflictBranch({
                ownerKey: userOwner,
                gameId: conflict.gameId,
                slotId: conflict.slotId,
                branch: "server",
                value: conflict.server,
              }),
            );
            await this.db.conflicts.add(conflict);
            await this.db.saves.update(target.id, { syncState: "conflict" });
            conflicts += 1;
          }
          await this.db.saves.delete(source.id);
        }
        let adoptedEvents = 0;
        for (const source of events) {
          const existing = await this.db.outbox.get(source.id);
          if (
            !existing ||
            existing.ownerKey !== anonymousOwner ||
            existing.payloadHash !== source.payloadHash
          ) {
            throw new VectorPersistenceError("VECTOR_IDEMPOTENCY_REUSED");
          }
          await this.db.outbox.update(existing.id, {
            ownerKey: userOwner,
            status: "pending",
            updatedAt: nowIso(),
          });
          adoptedEvents += 1;
        }
        return { adoptedSaves, conflicts, adoptedEvents };
      },
    );
  }

  async putInstall(input: Omit<VectorLocalInstall, "id">): Promise<void> {
    await this.db.installs.put({ ...input, id: installId(input.deviceId, input.gameId) });
  }

  async clearOwnerData(ownerKey: VectorOwnerKey): Promise<void> {
    await this.assertActive(ownerKey);
    await this.db.transaction(
      "rw",
      this.db.meta,
      this.db.profiles,
      this.db.saves,
      this.db.outbox,
      this.db.conflicts,
      async () => {
        await this.assertActive(ownerKey);
        await this.db.profiles.delete(ownerKey);
        await this.db.saves.where("ownerKey").equals(ownerKey).delete();
        await this.db.outbox.where("ownerKey").equals(ownerKey).delete();
        await this.db.conflicts.where("ownerKey").equals(ownerKey).delete();
        await this.db.meta.put({ key: ACTIVE_OWNER_META_KEY, value: null, updatedAt: nowIso() });
      },
    );
    if (this.activeOwner === ownerKey) this.activeOwner = null;
  }
}

export function cloudConflictToLocal(
  ownerKey: VectorOwnerKey,
  conflict: VectorCloudConflict,
): VectorLocalConflict {
  return {
    ...conflict,
    ownerKey,
    authority: "cloud",
    resolution: conflict.resolution ?? null,
  };
}

export async function openVectorRepository(
  database?: VectorDatabase,
): Promise<{
  repository: VectorPersistence;
  deviceId: string;
  ownerKey: VectorOwnerKey;
}> {
  const selectedDatabase = database ?? getVectorDatabase();
  let repository = repositoryByDatabase.get(selectedDatabase);
  if (!repository) {
    repository = new VectorPersistence(selectedDatabase);
    repositoryByDatabase.set(selectedDatabase, repository);
  }
  const initialized = await repository.initialize();
  return {
    repository,
    deviceId: initialized.deviceId,
    ownerKey: initialized.activeOwner,
  };
}

export async function changeVectorRepositoryOwner(input: {
  repository: VectorPersistence;
  deviceId: string;
  userId: string | null;
}): Promise<VectorOwnerKey> {
  const previous = input.repository.getActiveOwner();
  const next = input.userId
    ? vectorUserOwner(input.userId)
    : vectorAnonymousOwner(input.deviceId);
  if (previous !== next) await input.repository.activateOwner(next);
  return next;
}
