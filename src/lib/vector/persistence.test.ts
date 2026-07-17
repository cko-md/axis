import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  VectorBootstrapResponse,
  VectorSyncResponse,
} from "@/lib/vector/contracts";
import { VECTOR_PROFILE_MAX_DOCUMENT_BYTES } from "@/lib/vector/contracts";
import { checksumVectorState, vectorJsonBytes } from "@/lib/vector/checksum";
import {
  VectorDatabase,
  VectorPersistence,
  VectorPersistenceError,
  vectorAnonymousOwner,
  vectorUserOwner,
} from "@/lib/vector/persistence";

const DEVICE = "device-12345678";
const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const anonymous = vectorAnonymousOwner(DEVICE);
const userA = vectorUserOwner(USER_A);
const userB = vectorUserOwner(USER_B);

let db: VectorDatabase;
let repository: VectorPersistence;

function bootstrapResponse(
  saves: VectorBootstrapResponse["saves"],
): VectorBootstrapResponse {
  return {
    profile: null,
    saves,
    scores: [],
    achievements: [],
    conflicts: [],
    truncated: { saves: false, scores: false, achievements: false, conflicts: false },
    serverTime: new Date().toISOString(),
  };
}

beforeEach(async () => {
  db = new VectorDatabase(`axis-vector-test-${crypto.randomUUID()}`);
  repository = new VectorPersistence(db);
  await db.open();
  await repository.activateOwner(anonymous);
});

afterEach(async () => {
  db.close();
  await db.delete();
});

describe("VECTOR owner-partitioned persistence", () => {
  it("keeps account namespaces isolated and freezes the departing outbox", async () => {
    await repository.saveLocal({
      ownerKey: anonymous,
      gameId: "second-sense",
      slotId: "main",
      gameVersion: "1.0.0",
      saveSchemaVersion: 1,
      deviceId: DEVICE,
      seed: null,
      state: { round: 1 },
    });
    await repository.enqueueEvent(anonymous, "second-sense", {
      kind: "score",
      idempotencyKey: crypto.randomUUID(),
      localRevision: 1,
      occurredAt: new Date().toISOString(),
      payload: { mode: "solo", challengeId: null, value: 10 },
    });
    await repository.activateOwner(userA);

    await expect(repository.listSaves(anonymous)).rejects.toMatchObject({
      code: "VECTOR_OWNER_INACTIVE",
    });
    expect(await repository.listSaves(userA)).toEqual([]);
    expect((await db.outbox.where("ownerKey").equals(anonymous).first())?.status).toBe("frozen");
  });

  it("increments local revisions without waiting for cloud sync", async () => {
    await repository.activateOwner(userA);
    const first = await repository.saveLocal({
      ownerKey: userA,
      gameId: "second-sense",
      slotId: "main",
      gameVersion: "1.0.0",
      saveSchemaVersion: 1,
      deviceId: DEVICE,
      seed: "daily",
      state: { round: 1 },
    });
    const second = await repository.saveLocal({
      ownerKey: userA,
      gameId: "second-sense",
      slotId: "main",
      gameVersion: "1.0.0",
      saveSchemaVersion: 1,
      deviceId: DEVICE,
      seed: "daily",
      state: { round: 2 },
    });
    expect(first.localRevision).toBe(1);
    expect(second.localRevision).toBe(2);
    expect(second.serverRevision).toBe(0);
    expect(second.syncState).toBe("pending");
  });

  it("preserves both same-owner branches when a second repository writes a stale descendant", async () => {
    const first = new VectorPersistence(db);
    const second = new VectorPersistence(db);
    await first.activateOwner(userA);
    await second.activateOwner(userA);
    const base = await first.saveLocal({
      ownerKey: userA,
      gameId: "second-sense",
      slotId: "main",
      gameVersion: "1.0.0",
      saveSchemaVersion: 1,
      deviceId: DEVICE,
      seed: null,
      state: { round: 1 },
    });
    const ancestor = { localRevision: base.localRevision, checksum: base.checksum };
    const firstInput = {
      ownerKey: userA,
      gameId: "second-sense" as const,
      slotId: "main",
      gameVersion: "1.0.0",
      saveSchemaVersion: 1,
      deviceId: DEVICE,
      seed: null,
      state: { round: 2, branch: "first" },
    };
    const secondInput = {
      ...firstInput,
      state: { round: 2, branch: "second" },
    };
    const inputs = [firstInput, secondInput] as const;
    const repositories = [first, second] as const;
    const results = await Promise.all([
      first.saveLocalWithAncestor(firstInput, ancestor),
      second.saveLocalWithAncestor(secondInput, ancestor),
    ]);
    const savedIndex = results.findIndex((result) => result.status === "saved");
    const conflictIndex = results.findIndex((result) => result.status === "conflict");
    expect(savedIndex).toBeGreaterThanOrEqual(0);
    expect(conflictIndex).toBeGreaterThanOrEqual(0);
    const winner = results[savedIndex];
    const stale = results[conflictIndex];
    if (winner.status !== "saved" || stale.status !== "conflict") {
      throw new Error("expected one saved branch and one concurrent conflict");
    }
    expect(winner).toMatchObject({ status: "saved", save: { localRevision: 2 } });
    expect(stale).toMatchObject({
      status: "conflict",
      conflict: {
        reason: "local_concurrent_write",
        expectedAncestorLocalRevision: 1,
        expectedAncestorChecksum: base.checksum,
        currentLocalRevision: 2,
        local: { state: inputs[conflictIndex].state },
        server: { state: inputs[savedIndex].state },
      },
    });
    const repeated = await repositories[conflictIndex].saveLocalWithAncestor(
      inputs[conflictIndex],
      ancestor,
    );
    expect(repeated).toMatchObject({
      status: "conflict",
      conflict: { id: stale.conflict.id },
    });
    expect((await second.listConflicts(userA)).filter(
      (conflict) => conflict.status === "open",
    )).toHaveLength(1);
    expect(await db.saves.get(base.id)).toMatchObject({
      localRevision: 2,
      state: inputs[savedIndex].state,
      syncState: "conflict",
      lastErrorCode: "VECTOR_LOCAL_CONCURRENT_WRITE",
    });

    await repositories[conflictIndex].resolveLocalConflict(
      userA,
      stale.conflict.id,
      "accept-server",
    );
    expect(await repositories[conflictIndex].loadSave(
      userA,
      "second-sense",
      "main",
    )).toMatchObject({
      localRevision: 2,
      state: inputs[savedIndex].state,
      syncState: "pending",
      lastErrorCode: null,
    });
  });

  it("retains an in-flight acknowledgement when accepting the stale local branch", async () => {
    await repository.activateOwner(userA);
    const base = await repository.saveLocal({
      ownerKey: userA,
      gameId: "second-sense",
      slotId: "ack-race",
      gameVersion: "1.0.0",
      saveSchemaVersion: 1,
      deviceId: DEVICE,
      seed: null,
      state: { revision: 1 },
    });
    const ancestor = { localRevision: base.localRevision, checksum: base.checksum };
    const winner = await repository.saveLocalWithAncestor({
      ownerKey: userA,
      gameId: "second-sense",
      slotId: "ack-race",
      gameVersion: "1.0.0",
      saveSchemaVersion: 1,
      deviceId: DEVICE,
      seed: null,
      state: { revision: 2, branch: "winner" },
      checkpointLabel: "autosave",
    }, ancestor);
    if (winner.status !== "saved") throw new Error("missing winning save");
    const snapshot = await repository.createSyncSnapshot(userA, "second-sense", DEVICE);
    if (!snapshot) throw new Error("missing sync snapshot");
    const staleState = { revision: 2, branch: "stale" };
    const stale = await repository.saveLocalWithAncestor({
      ownerKey: userA,
      gameId: "second-sense",
      slotId: "ack-race",
      gameVersion: "1.0.0",
      saveSchemaVersion: 1,
      deviceId: DEVICE,
      seed: null,
      state: staleState,
      checkpointLabel: "manual",
    }, ancestor);
    if (stale.status !== "conflict") throw new Error("missing stale conflict");
    const transmitted = snapshot.transmittedSaves.find((save) => save.slotId === "ack-race");
    if (!transmitted) throw new Error("missing transmitted save");
    await repository.applySyncResponse(userA, snapshot, {
      partial: false,
      results: [{
        idempotencyKey: transmitted.idempotencyKey,
        kind: "save",
        status: "applied",
        code: null,
        slotId: "ack-race",
        localRevision: transmitted.localRevision,
        serverRevision: 7,
        conflictId: null,
      }],
      saves: [],
      conflicts: [],
      truncated: { saves: false, conflicts: false },
      serverTime: new Date().toISOString(),
    });
    await repository.resolveLocalConflict(userA, stale.conflict.id, "accept-local");
    expect(await repository.loadSave(userA, "second-sense", "ack-race")).toMatchObject({
      state: staleState,
      checkpointLabel: "manual",
      serverRevision: 7,
      syncState: "pending",
    });
  });

  it("preserves and idempotently binds a stale checkpoint label when forking", async () => {
    await repository.activateOwner(userA);
    const base = await repository.saveLocal({
      ownerKey: userA,
      gameId: "second-sense",
      slotId: "checkpoint-source",
      gameVersion: "1.0.0",
      saveSchemaVersion: 1,
      deviceId: DEVICE,
      seed: null,
      state: { revision: 1 },
      checkpointLabel: "base",
    });
    const ancestor = { localRevision: base.localRevision, checksum: base.checksum };
    const winner = await repository.saveLocalWithAncestor({
      ownerKey: userA,
      gameId: "second-sense",
      slotId: "checkpoint-source",
      gameVersion: "1.0.0",
      saveSchemaVersion: 1,
      deviceId: DEVICE,
      seed: null,
      state: { revision: 2, branch: "winner" },
      checkpointLabel: "winner-checkpoint",
    }, ancestor);
    if (winner.status !== "saved") throw new Error("missing winning save");
    const staleInput = {
      ownerKey: userA,
      gameId: "second-sense" as const,
      slotId: "checkpoint-source",
      gameVersion: "1.0.0",
      saveSchemaVersion: 1,
      deviceId: DEVICE,
      seed: null,
      state: { revision: 2, branch: "stale" },
      checkpointLabel: "forked-checkpoint",
    };
    const stale = await repository.saveLocalWithAncestor(staleInput, ancestor);
    if (stale.status !== "conflict") throw new Error("missing checkpoint conflict");
    await expect(repository.saveLocalWithAncestor({
      ...staleInput,
      checkpointLabel: "different-checkpoint",
    }, ancestor)).rejects.toMatchObject({ code: "VECTOR_SAVE_CONFLICT_OPEN" });
    await repository.resolveLocalConflict(
      userA,
      stale.conflict.id,
      "fork-local",
      "checkpoint-fork",
    );
    expect(await repository.loadSave(userA, "second-sense", "checkpoint-source"))
      .toMatchObject({ checkpointLabel: "winner-checkpoint", syncState: "pending" });
    expect(await repository.loadSave(userA, "second-sense", "checkpoint-fork"))
      .toMatchObject({ checkpointLabel: "forked-checkpoint", syncState: "pending" });
  });

  it("conflicts on a missing expected ancestor and enforces caps before restoring it", async () => {
    await repository.activateOwner(userA);
    await repository.ensureProfile(userA, DEVICE);
    const base = await repository.saveLocal({
      ownerKey: userA,
      gameId: "second-sense",
      slotId: "main",
      gameVersion: "1.0.0",
      saveSchemaVersion: 1,
      deviceId: DEVICE,
      seed: null,
      state: { round: 1 },
    });
    await db.saves.delete(base.id);
    const staleState = { round: 2, recovered: true };
    const result = await repository.saveLocalWithAncestor({
      ownerKey: userA,
      gameId: "second-sense",
      slotId: "main",
      gameVersion: "1.0.0",
      saveSchemaVersion: 2,
      deviceId: DEVICE,
      seed: null,
      state: staleState,
    }, { localRevision: base.localRevision, checksum: base.checksum });
    expect(result).toMatchObject({
      status: "conflict",
      conflict: {
        reason: "local_concurrent_write",
        currentLocalRevision: null,
        currentIntegrityChecksum: null,
        server: { serverRevision: 0 },
      },
    });
    if (result.status !== "conflict") throw new Error("missing delete conflict");
    expect(await repository.loadSave(userA, "second-sense", "main")).toBeNull();

    for (let slot = 0; slot < 8; slot += 1) {
      await repository.saveLocal({
        ownerKey: userA,
        gameId: "second-sense",
        slotId: `occupied-${slot}`,
        gameVersion: "1.0.0",
        saveSchemaVersion: 1,
        deviceId: DEVICE,
        seed: null,
        state: { slot },
      });
    }
    await expect(repository.resolveLocalConflict(
      userA,
      result.conflict.id,
      "accept-local",
    )).rejects.toMatchObject({ code: "VECTOR_SAVE_SLOT_LIMIT" });
    await db.saves.delete(`${userA}|second-sense|occupied-7`);
    await repository.resolveLocalConflict(userA, result.conflict.id, "accept-local");
    expect(await repository.loadSave(userA, "second-sense", "main")).toMatchObject({
      state: staleState,
      localRevision: 3,
      syncState: "pending",
    });
    expect((await repository.listVerifiedSaves(userA, "second-sense")).saves).toHaveLength(8);
  });

  it("keeps a concurrently deleted current slot absent without requiring profile state", async () => {
    await repository.activateOwner(userB);
    const source = await repository.saveLocal({
      ownerKey: userB,
      gameId: "second-sense",
      slotId: "deleted-current",
      gameVersion: "1.0.0",
      saveSchemaVersion: 1,
      deviceId: DEVICE,
      seed: null,
      state: { beforeDelete: true },
    });
    await db.saves.delete(source.id);
    const result = await repository.saveLocalWithAncestor({
      ownerKey: userB,
      gameId: "second-sense",
      slotId: "deleted-current",
      gameVersion: "1.0.0",
      saveSchemaVersion: 1,
      deviceId: DEVICE,
      seed: null,
      state: { staleWrite: true },
    }, { localRevision: source.localRevision, checksum: source.checksum });
    if (result.status !== "conflict") throw new Error("missing delete conflict");
    await repository.resolveLocalConflict(userB, result.conflict.id, "accept-server");
    expect(await repository.loadSave(userB, "second-sense", "deleted-current")).toBeNull();
  });

  it("validates every local save identifier and bounded field before writing", async () => {
    await repository.activateOwner(userA);
    const base = {
      ownerKey: userA,
      gameId: "second-sense" as const,
      slotId: "main",
      gameVersion: "1.0.0",
      saveSchemaVersion: 1,
      deviceId: DEVICE,
      seed: null,
      state: { round: 1 },
    };
    for (const invalid of [
      { slotId: "../escape" },
      { gameVersion: "bad version" },
      { saveSchemaVersion: 0 },
      { deviceId: "short" },
      { seed: "x".repeat(257) },
      { state: Number.NaN },
    ]) {
      await expect(repository.saveLocal({ ...base, ...invalid })).rejects.toMatchObject({
        code: "VECTOR_SAVE_INPUT_INVALID",
      });
    }
    expect(await repository.listSaves(userA)).toHaveLength(0);
  });

  it("normalizes local IndexedDB quota failures without erasing state", async () => {
    await repository.activateOwner(userA);
    const quotaError = Object.assign(new Error("full"), { name: "QuotaExceededError" });
    vi.spyOn(db.saves, "put").mockRejectedValueOnce(quotaError);
    await expect(repository.saveLocal({
      ownerKey: userA,
      gameId: "second-sense",
      slotId: "main",
      gameVersion: "1.0.0",
      saveSchemaVersion: 1,
      deviceId: DEVICE,
      seed: null,
      state: { round: 1 },
    })).rejects.toMatchObject({ code: "VECTOR_LOCAL_QUOTA_EXCEEDED" });
    expect(await repository.listSaves(userA)).toHaveLength(0);
  });

  it("enforces the per-game save-slot cap atomically", async () => {
    await repository.activateOwner(userA);
    for (let slot = 0; slot < 8; slot += 1) {
      await repository.saveLocal({
        ownerKey: userA,
        gameId: "second-sense",
        slotId: `slot-${slot}`,
        gameVersion: "1.0.0",
        saveSchemaVersion: 1,
        deviceId: DEVICE,
        seed: null,
        state: { slot },
      });
    }
    await expect(repository.saveLocal({
      ownerKey: userA,
      gameId: "second-sense",
      slotId: "slot-8",
      gameVersion: "1.0.0",
      saveSchemaVersion: 1,
      deviceId: DEVICE,
      seed: null,
      state: { slot: 8 },
    })).rejects.toMatchObject({ code: "VECTOR_SAVE_SLOT_LIMIT" });
    await expect(repository.saveLocal({
      ownerKey: userA,
      gameId: "second-sense",
      slotId: "slot-0",
      gameVersion: "1.0.0",
      saveSchemaVersion: 1,
      deviceId: DEVICE,
      seed: null,
      state: { slot: 0, updated: true },
    })).resolves.toMatchObject({ localRevision: 2 });
  });

  it("does not mark a newer local revision synced from an older acknowledgement", async () => {
    await repository.activateOwner(userA);
    await repository.saveLocal({
      ownerKey: userA,
      gameId: "second-sense",
      slotId: "main",
      gameVersion: "1.0.0",
      saveSchemaVersion: 1,
      deviceId: DEVICE,
      seed: null,
      state: { round: 1 },
    });
    const snapshot = await repository.createSyncSnapshot(userA, "second-sense", DEVICE);
    if (!snapshot) throw new Error("missing snapshot");
    await repository.saveLocal({
      ownerKey: userA,
      gameId: "second-sense",
      slotId: "main",
      gameVersion: "1.0.0",
      saveSchemaVersion: 1,
      deviceId: DEVICE,
      seed: null,
      state: { round: 2 },
    });
    const response: VectorSyncResponse = {
      partial: false,
      results: [{
        idempotencyKey: snapshot.transmittedSaves[0].idempotencyKey,
        kind: "save",
        status: "applied",
        code: null,
        slotId: "main",
        localRevision: 1,
        serverRevision: 1,
        conflictId: null,
      }],
      saves: [],
      conflicts: [],
      truncated: { saves: false, conflicts: false },
      serverTime: new Date().toISOString(),
    };
    await repository.applySyncResponse(userA, snapshot, response);
    expect(await repository.loadSave(userA, "second-sense", "main")).toMatchObject({
      localRevision: 2,
      serverRevision: 0,
      syncState: "pending",
    });
  });

  it("returns in-flight saves to pending before switching owner namespaces", async () => {
    await repository.activateOwner(userA);
    await repository.saveLocal({
      ownerKey: userA,
      gameId: "second-sense",
      slotId: "main",
      gameVersion: "1.0.0",
      saveSchemaVersion: 1,
      deviceId: DEVICE,
      seed: null,
      state: { round: 1 },
    });
    const snapshot = await repository.createSyncSnapshot(userA, "second-sense", DEVICE);
    expect(snapshot).not.toBeNull();
    await repository.activateOwner(userB);
    expect((await db.saves.where("ownerKey").equals(userA).first())?.syncState).toBe("pending");
  });

  it("marks transmitted items omitted by a response as retryable errors", async () => {
    await repository.activateOwner(userA);
    await repository.saveLocal({
      ownerKey: userA,
      gameId: "second-sense",
      slotId: "main",
      gameVersion: "1.0.0",
      saveSchemaVersion: 1,
      deviceId: DEVICE,
      seed: null,
      state: { round: 1 },
    });
    const event = await repository.enqueueEvent(userA, "second-sense", {
      kind: "achievement",
      idempotencyKey: crypto.randomUUID(),
      localRevision: 1,
      occurredAt: new Date().toISOString(),
      payload: { achievementId: "first-run" },
    });
    const snapshot = await repository.createSyncSnapshot(userA, "second-sense", DEVICE);
    if (!snapshot) throw new Error("missing snapshot");
    await repository.applySyncResponse(userA, snapshot, {
      partial: true,
      results: [],
      saves: [],
      conflicts: [],
      truncated: { saves: false, conflicts: false },
      serverTime: new Date().toISOString(),
    });
    expect(await repository.loadSave(userA, "second-sense", "main")).toMatchObject({
      syncState: "error",
      lastErrorCode: "VECTOR_SYNC_RESPONSE_INCOMPLETE",
    });
    expect(await db.outbox.get(event.id)).toMatchObject({
      status: "error",
      lastErrorCode: "VECTOR_SYNC_RESPONSE_INCOMPLETE",
    });
  });

  it("requires an event acknowledgement to match kind and local revision", async () => {
    await repository.activateOwner(userA);
    const event = await repository.enqueueEvent(userA, "second-sense", {
      kind: "achievement",
      idempotencyKey: crypto.randomUUID(),
      localRevision: 4,
      occurredAt: new Date().toISOString(),
      payload: { achievementId: "first-run" },
    });
    const snapshot = await repository.createSyncSnapshot(userA, "second-sense", DEVICE);
    if (!snapshot) throw new Error("missing snapshot");
    await repository.applySyncResponse(userA, snapshot, {
      partial: false,
      results: [{
        idempotencyKey: event.id,
        kind: "counter",
        status: "applied",
        code: null,
        slotId: null,
        localRevision: 999,
        serverRevision: null,
        conflictId: null,
      }],
      saves: [],
      conflicts: [],
      truncated: { saves: false, conflicts: false },
      serverTime: new Date().toISOString(),
    });
    expect(await db.outbox.get(event.id)).toMatchObject({
      status: "error",
      lastErrorCode: "VECTOR_SYNC_RESPONSE_INCOMPLETE",
    });
  });

  it("marks profile settings synced only after their matching event is acknowledged", async () => {
    await repository.activateOwner(userA);
    expect(await repository.ensureProfile(userA, DEVICE)).toMatchObject({
      syncState: "synced",
      serverRevision: 0,
    });
    const at = new Date().toISOString();
    await repository.updateProfileSettings({
      ownerKey: userA,
      gameId: "second-sense",
      deviceId: DEVICE,
      values: { muted: true },
      clocks: { muted: { at, deviceId: DEVICE } },
    });
    const event = (await repository.listOutbox(userA, "second-sense"))[0];
    const snapshot = await repository.createSyncSnapshot(userA, "second-sense", DEVICE);
    if (!snapshot) throw new Error("missing snapshot");
    await repository.applySyncResponse(userA, snapshot, {
      partial: false,
      results: [{
        idempotencyKey: event.id,
        kind: "settings",
        status: "applied",
        code: null,
        slotId: null,
        localRevision: event.event.localRevision,
        serverRevision: 7,
        conflictId: null,
      }],
      saves: [],
      conflicts: [],
      truncated: { saves: false, conflicts: false },
      serverTime: new Date().toISOString(),
    });
    expect(await repository.loadProfile(userA)).toMatchObject({
      settings: { muted: true },
      syncState: "synced",
      serverRevision: 7,
    });
    expect(await repository.listOutbox(userA)).toHaveLength(0);
  });

  it("rejects future setting clocks locally and quarantines a server-rejected event", async () => {
    await repository.activateOwner(userA);
    await repository.ensureProfile(userA, DEVICE);
    const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    await expect(repository.updateProfileSettings({
      ownerKey: userA,
      gameId: "second-sense",
      deviceId: DEVICE,
      values: { muted: true },
      clocks: { muted: { at: future, deviceId: DEVICE } },
    })).rejects.toMatchObject({ code: "VECTOR_SETTING_CLOCK_FUTURE" });
    expect(await repository.listOutbox(userA)).toHaveLength(0);

    const at = new Date().toISOString();
    await repository.updateProfileSettings({
      ownerKey: userA,
      gameId: "second-sense",
      deviceId: DEVICE,
      values: { muted: true },
      clocks: { muted: { at, deviceId: DEVICE } },
    });
    const snapshot = await repository.createSyncSnapshot(userA, "second-sense", DEVICE);
    if (!snapshot) throw new Error("missing settings snapshot");
    const event = snapshot.body.events[0];
    await repository.applySyncResponse(userA, snapshot, {
      partial: true,
      results: [{
        idempotencyKey: event.idempotencyKey,
        kind: "settings",
        status: "rejected",
        code: "VECTOR_SETTING_CLOCK_FUTURE",
        slotId: null,
        localRevision: event.localRevision,
        serverRevision: null,
        conflictId: null,
      }],
      saves: [],
      conflicts: [],
      truncated: { saves: false, conflicts: false },
      serverTime: new Date().toISOString(),
    });
    expect(await repository.loadProfile(userA)).toMatchObject({
      settings: {},
      settingClocks: {},
      syncState: "error",
    });
    expect(await repository.listOutbox(userA)).toMatchObject([{
      status: "error",
      lastErrorCode: "VECTOR_SETTING_CLOCK_FUTURE",
    }]);
    await expect(repository.countPendingSyncWork(userA, "second-sense")).resolves.toBe(0);
    await expect(repository.createSyncSnapshot(userA, "second-sense", DEVICE)).resolves.toBeNull();
    await repository.activateOwner(userB);
    await repository.activateOwner(userA);
    expect(await repository.listOutbox(userA)).toMatchObject([{
      status: "error",
      lastErrorCode: "VECTOR_SETTING_CLOCK_FUTURE",
    }]);
    await expect(repository.countPendingSyncWork(userA, "second-sense")).resolves.toBe(0);
  });

  it("advances a behind-device setting clock without exceeding the future bound", async () => {
    await repository.activateOwner(userA);
    await repository.ensureProfile(userA, DEVICE);
    const existingAt = new Date(Date.now() + 2 * 60 * 1000).toISOString();
    await db.profiles.update(userA, {
      settings: { muted: false },
      settingClocks: { muted: { at: existingAt, deviceId: "device-remote" } },
    });
    const updated = await repository.updateProfileSettings({
      ownerKey: userA,
      gameId: "second-sense",
      deviceId: DEVICE,
      values: { muted: true },
      clocks: { muted: { at: new Date().toISOString(), deviceId: DEVICE } },
    });
    expect(updated.settings.muted).toBe(true);
    expect(Date.parse(updated.settingClocks.muted.at)).toBeGreaterThan(Date.parse(existingAt));
    expect(Date.parse(updated.settingClocks.muted.at)).toBeLessThanOrEqual(
      Date.now() + 5 * 60 * 1000,
    );
    const [event] = await repository.listOutbox(userA, "second-sense");
    expect(event.event).toMatchObject({
      kind: "settings",
      payload: { clocks: { muted: updated.settingClocks.muted } },
    });
  });

  it("hydrates remote-only saves and replaces only clean local state", async () => {
    await repository.activateOwner(userA);
    const firstState = { round: "cloud-1" };
    await repository.applyBootstrap(userA, DEVICE, bootstrapResponse([{
      gameId: "second-sense",
      slotId: "remote",
      gameVersion: "1.0.0",
      saveSchemaVersion: 1,
      serverRevision: 1,
      clientRevision: 1,
      deviceId: "device-remote-1",
      checksum: await checksumVectorState(firstState),
      seed: null,
      state: firstState,
      updatedAt: new Date().toISOString(),
      deletedAt: null,
    }]));
    expect(await repository.loadSave(userA, "second-sense", "remote")).toMatchObject({
      state: firstState,
      syncState: "synced",
      serverRevision: 1,
    });
    const secondState = { round: "cloud-2" };
    await repository.applyBootstrap(userA, DEVICE, bootstrapResponse([{
      gameId: "second-sense",
      slotId: "remote",
      gameVersion: "1.1.0",
      saveSchemaVersion: 1,
      serverRevision: 2,
      clientRevision: 2,
      deviceId: "device-remote-2",
      checksum: await checksumVectorState(secondState),
      seed: null,
      state: secondState,
      updatedAt: new Date().toISOString(),
      deletedAt: null,
    }]));
    expect(await repository.loadSave(userA, "second-sense", "remote")).toMatchObject({
      state: secondState,
      syncState: "synced",
      serverRevision: 2,
    });
  });

  it("preserves a pending local branch when bootstrap finds remote divergence", async () => {
    await repository.activateOwner(userA);
    await repository.saveLocal({
      ownerKey: userA,
      gameId: "second-sense",
      slotId: "main",
      gameVersion: "1.0.0",
      saveSchemaVersion: 1,
      deviceId: DEVICE,
      seed: null,
      state: { branch: "local" },
    });
    const remoteState = { branch: "remote" };
    await repository.applyBootstrap(userA, DEVICE, bootstrapResponse([{
      gameId: "second-sense",
      slotId: "main",
      gameVersion: "1.0.0",
      saveSchemaVersion: 1,
      serverRevision: 3,
      clientRevision: 7,
      deviceId: "device-remote-1",
      checksum: await checksumVectorState(remoteState),
      seed: null,
      state: remoteState,
      updatedAt: new Date().toISOString(),
      deletedAt: null,
    }]));
    expect(await repository.loadSave(userA, "second-sense", "main")).toMatchObject({
      state: { branch: "local" },
      syncState: "conflict",
    });
    expect(await repository.listConflicts(userA, "second-sense")).toMatchObject([{
      reason: "remote_divergence",
      local: { state: { branch: "local" } },
      server: { state: remoteState },
    }]);
  });

  it("treats an equal server revision as the pending local branch's CAS ancestor", async () => {
    await repository.activateOwner(userA);
    const baseline = { branch: "baseline" };
    await repository.applyBootstrap(userA, DEVICE, bootstrapResponse([{
      gameId: "second-sense",
      slotId: "main",
      gameVersion: "1.0.0",
      saveSchemaVersion: 1,
      serverRevision: 1,
      clientRevision: 1,
      deviceId: "device-remote-1",
      checksum: await checksumVectorState(baseline),
      seed: null,
      state: baseline,
      updatedAt: new Date().toISOString(),
      deletedAt: null,
    }]));
    await repository.saveLocal({
      ownerKey: userA,
      gameId: "second-sense",
      slotId: "main",
      gameVersion: "1.0.0",
      saveSchemaVersion: 1,
      deviceId: DEVICE,
      seed: null,
      state: { branch: "local" },
    });
    const divergent = { branch: "other-device" };
    await repository.applyBootstrap(userA, DEVICE, bootstrapResponse([{
      gameId: "second-sense",
      slotId: "main",
      gameVersion: "1.0.0",
      saveSchemaVersion: 1,
      serverRevision: 1,
      clientRevision: 2,
      deviceId: "device-remote-2",
      checksum: await checksumVectorState(divergent),
      seed: null,
      state: divergent,
      updatedAt: new Date().toISOString(),
      deletedAt: null,
    }]));
    expect(await repository.loadSave(userA, "second-sense", "main")).toMatchObject({
      state: { branch: "local" },
      syncState: "pending",
    });
    expect(await repository.listConflicts(userA, "second-sense")).toHaveLength(0);
  });

  it("imports remote-only saves returned by sync", async () => {
    await repository.activateOwner(userA);
    const event = await repository.enqueueEvent(userA, "second-sense", {
      kind: "achievement",
      idempotencyKey: crypto.randomUUID(),
      localRevision: 1,
      occurredAt: new Date().toISOString(),
      payload: { achievementId: "first-run" },
    });
    const snapshot = await repository.createSyncSnapshot(userA, "second-sense", DEVICE);
    if (!snapshot) throw new Error("missing snapshot");
    const state = { remote: true };
    await repository.applySyncResponse(userA, snapshot, {
      partial: false,
      results: [{
        idempotencyKey: event.id,
        kind: "achievement",
        status: "applied",
        code: null,
        slotId: null,
        localRevision: 1,
        serverRevision: null,
        conflictId: null,
      }],
      saves: [{
        gameId: "second-sense",
        slotId: "cloud",
        gameVersion: "1.0.0",
        saveSchemaVersion: 1,
        serverRevision: 1,
        clientRevision: 1,
        deviceId: "device-remote-1",
        checksum: await checksumVectorState(state),
        seed: null,
        state,
        updatedAt: new Date().toISOString(),
        deletedAt: null,
      }],
      conflicts: [],
      truncated: { saves: false, conflicts: false },
      serverTime: new Date().toISOString(),
    });
    expect(await repository.loadSave(userA, "second-sense", "cloud")).toMatchObject({
      state,
      syncState: "synced",
    });
  });

  it("deduplicates identical events and rejects idempotency reuse", async () => {
    await repository.activateOwner(userA);
    const idempotencyKey = crypto.randomUUID();
    const event = {
      kind: "achievement" as const,
      idempotencyKey,
      localRevision: 1,
      occurredAt: new Date().toISOString(),
      payload: { achievementId: "first-run" },
    };
    const first = await repository.enqueueEvent(userA, "second-sense", event);
    const duplicate = await repository.enqueueEvent(userA, "second-sense", event);
    expect(duplicate.id).toBe(first.id);
    await expect(repository.enqueueEvent(userA, "second-sense", {
      ...event,
      payload: { achievementId: "different" },
    })).rejects.toBeInstanceOf(VectorPersistenceError);
  });

  it("requires explicit anonymous adoption and preserves collisions", async () => {
    await repository.saveLocal({
      ownerKey: anonymous,
      gameId: "second-sense",
      slotId: "main",
      gameVersion: "1.0.0",
      saveSchemaVersion: 1,
      deviceId: DEVICE,
      seed: null,
      state: { round: "anonymous" },
      checkpointLabel: "anonymous-checkpoint",
    });
    await repository.enqueueEvent(anonymous, "second-sense", {
      kind: "achievement",
      idempotencyKey: crypto.randomUUID(),
      localRevision: 1,
      occurredAt: new Date().toISOString(),
      payload: { achievementId: "anonymous-run" },
    });
    await repository.activateOwner(userA);
    await repository.saveLocal({
      ownerKey: userA,
      gameId: "second-sense",
      slotId: "main",
      gameVersion: "1.0.0",
      saveSchemaVersion: 1,
      deviceId: DEVICE,
      seed: null,
      state: { round: "account" },
      checkpointLabel: "account-checkpoint",
    });
    expect(await repository.previewAnonymousAdoption(anonymous, userA)).toMatchObject({
      saves: 1,
      collisions: 1,
    });
    const adopted = await repository.adoptAnonymousData(anonymous, userA, DEVICE);
    expect(adopted).toMatchObject({ conflicts: 1, adoptedEvents: 1 });
    expect(await repository.listConflicts(userA)).toHaveLength(1);
    expect(await repository.loadSave(userA, "second-sense", "main")).toMatchObject({
      state: { round: "account" },
      syncState: "conflict",
    });
    expect(await repository.previewAnonymousAdoption(anonymous, userA)).toEqual({
      saves: 0,
      events: 0,
      collisions: 0,
    });
    expect(await db.saves.where("ownerKey").equals(anonymous).count()).toBe(0);
    const conflict = (await repository.listConflicts(userA))[0];
    await repository.resolveLocalConflict(userA, conflict.id, "accept-local");
    expect(await repository.loadSave(userA, "second-sense", "main")).toMatchObject({
      state: { round: "anonymous" },
      checkpointLabel: "anonymous-checkpoint",
      syncState: "pending",
    });
  });

  it("refuses to discard a corrupt anonymous save during adoption", async () => {
    const source = await repository.saveLocal({
      ownerKey: anonymous,
      gameId: "second-sense",
      slotId: "corrupt-adoption",
      gameVersion: "1.0.0",
      saveSchemaVersion: 1,
      deviceId: DEVICE,
      seed: null,
      state: { trusted: true },
    });
    await db.saves.update(source.id, { state: { tampered: true } });
    await repository.activateOwner(userA);
    await expect(repository.adoptAnonymousData(anonymous, userA, DEVICE))
      .rejects.toMatchObject({ code: "VECTOR_SAVE_CORRUPT" });
    expect(await db.saves.get(source.id)).toMatchObject({ state: { tampered: true } });
    expect(await repository.listSaves(userA, "second-sense")).toHaveLength(0);
  });

  it("fails anonymous adoption atomically when it would exceed the slot cap", async () => {
    await repository.saveLocal({
      ownerKey: anonymous,
      gameId: "second-sense",
      slotId: "anonymous-extra",
      gameVersion: "1.0.0",
      saveSchemaVersion: 1,
      deviceId: DEVICE,
      seed: null,
      state: { source: "anonymous" },
    });
    await repository.activateOwner(userA);
    for (let slot = 0; slot < 8; slot += 1) {
      await repository.saveLocal({
        ownerKey: userA,
        gameId: "second-sense",
        slotId: `user-${slot}`,
        gameVersion: "1.0.0",
        saveSchemaVersion: 1,
        deviceId: DEVICE,
        seed: null,
        state: { slot },
      });
    }
    await expect(
      repository.adoptAnonymousData(anonymous, userA, DEVICE),
    ).rejects.toMatchObject({ code: "VECTOR_SAVE_SLOT_LIMIT" });
    expect(await repository.listSaves(userA, "second-sense")).toHaveLength(8);
    expect(await db.saves.where("ownerKey").equals(anonymous).count()).toBe(1);
  });

  it("quarantines a checksum mismatch once without erasing the source", async () => {
    await repository.activateOwner(userB);
    const save = await repository.saveLocal({
      ownerKey: userB,
      gameId: "second-sense",
      slotId: "main",
      gameVersion: "1.0.0",
      saveSchemaVersion: 1,
      deviceId: DEVICE,
      seed: null,
      state: { round: 1 },
    });
    await db.saves.update(save.id, { state: { round: 999 } });
    await expect(repository.loadSave(userB, "second-sense", "main")).rejects.toMatchObject({
      code: "VECTOR_SAVE_CORRUPT",
    });
    await expect(repository.loadSave(userB, "second-sense", "main")).rejects.toMatchObject({
      code: "VECTOR_SAVE_CORRUPT",
    });
    expect(await repository.listConflicts(userB)).toHaveLength(1);
    expect((await db.saves.get(save.id))?.state).toEqual({ round: 999 });
  });

  it("refuses to overwrite a corrupt predecessor before quarantine", async () => {
    await repository.activateOwner(userA);
    const source = await repository.saveLocal({
      ownerKey: userA,
      gameId: "second-sense",
      slotId: "main",
      gameVersion: "1.0.0",
      saveSchemaVersion: 1,
      deviceId: DEVICE,
      seed: null,
      state: { round: 1 },
    });
    await db.saves.update(source.id, { state: { tampered: true } });
    await expect(repository.saveLocal({
      ownerKey: userA,
      gameId: "second-sense",
      slotId: "main",
      gameVersion: "1.0.0",
      saveSchemaVersion: 1,
      deviceId: DEVICE,
      seed: null,
      state: { round: 2 },
    })).rejects.toMatchObject({ code: "VECTOR_SAVE_CORRUPT" });
    expect(await db.saves.get(source.id)).toMatchObject({
      state: { tampered: true },
      localRevision: 1,
    });
    await expect(repository.loadSave(userA, "second-sense", "main"))
      .rejects.toMatchObject({ code: "VECTOR_SAVE_CORRUPT" });
    expect(await repository.listConflicts(userA)).toHaveLength(1);
  });

  it("shares device identity and revokes stale repositories across JS realms", async () => {
    const first = new VectorPersistence(db);
    const second = new VectorPersistence(db);
    const [firstInit, secondInit] = await Promise.all([first.initialize(), second.initialize()]);
    expect(firstInit.deviceId).toBe(secondInit.deviceId);
    await first.activateOwner(userA);
    await second.activateOwner(userA);
    const event = await first.enqueueEvent(userA, "second-sense", {
      kind: "achievement",
      idempotencyKey: crypto.randomUUID(),
      localRevision: 1,
      occurredAt: new Date().toISOString(),
      payload: { achievementId: "realm-switch" },
    });
    await second.activateOwner(userB);
    await expect(first.listSaves(userA)).rejects.toMatchObject({
      code: "VECTOR_OWNER_INACTIVE",
    });
    await expect(first.saveLocal({
      ownerKey: userA,
      gameId: "second-sense",
      slotId: "stale-write",
      gameVersion: "1.0.0",
      saveSchemaVersion: 1,
      deviceId: DEVICE,
      seed: null,
      state: { stale: true },
    })).rejects.toMatchObject({ code: "VECTOR_OWNER_INACTIVE" });
    expect(await db.outbox.get(event.id)).toMatchObject({ status: "frozen" });
  });

  it("lists only checksum-verified saves and quarantines corrupt rows before hydration", async () => {
    await repository.activateOwner(userA);
    const save = await repository.saveLocal({
      ownerKey: userA,
      gameId: "second-sense",
      slotId: "main",
      gameVersion: "1.0.0",
      saveSchemaVersion: 1,
      deviceId: DEVICE,
      seed: null,
      state: { trusted: true },
    });
    await db.saves.update(save.id, { state: { tampered: true } });
    await expect(repository.listVerifiedSaves(userA)).resolves.toMatchObject({
      saves: [],
      quarantined: 1,
      unscopedQuarantined: 0,
    });
    expect(await repository.listConflicts(userA)).toMatchObject([{
      authority: "local",
      reason: "local_checksum_mismatch",
      status: "open",
    }]);
  });

  it("stops platform hydration only when a corrupt row cannot be assigned to a game", async () => {
    await repository.activateOwner(userA);
    const save = await repository.saveLocal({
      ownerKey: userA,
      gameId: "second-sense",
      slotId: "main",
      gameVersion: "1.0.0",
      saveSchemaVersion: 1,
      deviceId: DEVICE,
      seed: null,
      state: { trusted: true },
    });
    await db.saves.update(save.id, { gameId: "unknown-game" as never });

    await expect(repository.listVerifiedSaves(userA)).resolves.toMatchObject({
      saves: [],
      quarantined: 1,
      unscopedQuarantined: 1,
    });
    expect(await repository.listConflicts(userA)).toEqual([]);
    expect(await db.saves.get(save.id)).toMatchObject({
      lastErrorCode: "VECTOR_SAVE_CORRUPT",
      syncState: "conflict",
    });
  });

  it("rolls back settings when the atomic outbox write fails", async () => {
    await repository.activateOwner(userA);
    await repository.ensureProfile(userA, DEVICE);
    const quotaError = Object.assign(new Error("full"), { name: "QuotaExceededError" });
    vi.spyOn(db.outbox, "add").mockRejectedValueOnce(quotaError);
    const at = new Date().toISOString();
    await expect(repository.updateProfileSettings({
      ownerKey: userA,
      gameId: "second-sense",
      deviceId: DEVICE,
      values: { muted: true },
      clocks: { muted: { at, deviceId: DEVICE } },
    })).rejects.toMatchObject({ code: "VECTOR_LOCAL_QUOTA_EXCEEDED" });
    expect(await repository.loadProfile(userA)).toMatchObject({
      settings: {},
      syncState: "synced",
    });
    expect(await repository.listOutbox(userA)).toHaveLength(0);
  });

  it("blocks direct writes while an explicit save conflict is open", async () => {
    await repository.activateOwner(userA);
    await repository.saveLocal({
      ownerKey: userA,
      gameId: "second-sense",
      slotId: "main",
      gameVersion: "1.0.0",
      saveSchemaVersion: 1,
      deviceId: DEVICE,
      seed: null,
      state: { branch: "local" },
    });
    const remote = { branch: "remote" };
    await repository.applyBootstrap(userA, DEVICE, bootstrapResponse([{
      gameId: "second-sense",
      slotId: "main",
      gameVersion: "1.0.0",
      saveSchemaVersion: 1,
      serverRevision: 2,
      clientRevision: 2,
      deviceId: "device-remote-1",
      checksum: await checksumVectorState(remote),
      seed: null,
      state: remote,
      updatedAt: new Date().toISOString(),
      deletedAt: null,
    }]));
    await expect(repository.saveLocal({
      ownerKey: userA,
      gameId: "second-sense",
      slotId: "main",
      gameVersion: "1.0.0",
      saveSchemaVersion: 1,
      deviceId: DEVICE,
      seed: null,
      state: { overwritten: true },
    })).rejects.toMatchObject({ code: "VECTOR_SAVE_CONFLICT_OPEN" });
    const conflict = (await repository.listConflicts(userA, "second-sense"))[0];
    await db.conflicts.update(conflict.id, {
      local: { ...conflict.local, seed: "tampered-envelope" },
    });
    await expect(repository.resolveLocalConflict(
      userA,
      conflict.id,
      "accept-local",
    )).rejects.toMatchObject({ code: "VECTOR_CONFLICT_BRANCH_INVALID" });
  });

  it("enforces the slot cap when resolution would recreate a missing original", async () => {
    await repository.activateOwner(userA);
    await repository.ensureProfile(userA, DEVICE);
    for (let index = 0; index < 8; index += 1) {
      await repository.saveLocal({
        ownerKey: userA,
        gameId: "second-sense",
        slotId: `occupied-${index}`,
        gameVersion: "1.0.0",
        saveSchemaVersion: 1,
        deviceId: DEVICE,
        seed: null,
        state: { index },
      });
    }
    const localState = { missing: "local" };
    const serverState = { missing: "server" };
    const createdAt = new Date().toISOString();
    const conflictId = crypto.randomUUID();
    await db.conflicts.put({
      id: conflictId,
      ownerKey: userA,
      authority: "local",
      gameId: "second-sense",
      slotId: "missing-original",
      reason: "remote_divergence",
      conflictVersion: 1,
      status: "open",
      resolution: null,
      local: {
        localRevision: 1,
        gameVersion: "1.0.0",
        saveSchemaVersion: 1,
        checksum: await checksumVectorState(localState),
        seed: null,
        state: localState,
        updatedAt: createdAt,
      },
      server: {
        serverRevision: 1,
        gameVersion: "1.0.0",
        saveSchemaVersion: 1,
        checksum: await checksumVectorState(serverState),
        seed: null,
        state: serverState,
        updatedAt: createdAt,
      },
      createdAt,
      resolvedAt: null,
    });
    await expect(repository.resolveLocalConflict(
      userA,
      conflictId,
      "accept-server",
    )).rejects.toMatchObject({ code: "VECTOR_SAVE_SLOT_LIMIT" });
  });

  it("discards a quarantined revision-zero branch only through explicit resolution", async () => {
    await repository.activateOwner(userA);
    const save = await repository.saveLocal({
      ownerKey: userA,
      gameId: "second-sense",
      slotId: "main",
      gameVersion: "1.0.0",
      saveSchemaVersion: 1,
      deviceId: DEVICE,
      seed: null,
      state: { valid: true },
    });
    await db.saves.update(save.id, { state: { corrupt: true } });
    await repository.listVerifiedSaves(userA);
    const conflict = (await repository.listConflicts(userA))[0];
    await expect(repository.resolveLocalConflict(
      userA,
      conflict.id,
      "accept-local",
    )).rejects.toMatchObject({ code: "VECTOR_CONFLICT_BRANCH_INVALID" });
    await expect(repository.resolveLocalConflict(
      userA,
      conflict.id,
      "accept-server",
    )).resolves.toMatchObject({ status: "resolved", resolution: "accept-server" });
    expect(await repository.loadSave(userA, "second-sense", "main")).toBeNull();
  });

  it("hydrates one corrupt synced conflict from cloud and restores it explicitly", async () => {
    await repository.activateOwner(userA);
    const trusted = { branch: "trusted-cloud" };
    const remote = {
      gameId: "second-sense" as const,
      slotId: "main",
      gameVersion: "1.0.0",
      saveSchemaVersion: 1,
      serverRevision: 1,
      clientRevision: 1,
      deviceId: "device-remote-1",
      checksum: await checksumVectorState(trusted),
      seed: null,
      state: trusted,
      updatedAt: new Date().toISOString(),
      deletedAt: null,
    };
    await repository.applyBootstrap(userA, DEVICE, bootstrapResponse([remote]));
    const stored = await repository.loadSave(userA, "second-sense", "main");
    if (!stored) throw new Error("missing cloud save");
    await db.saves.update(stored.id, { state: { branch: "corrupt" } });
    await repository.listVerifiedSaves(userA);
    const unhydrated = (await repository.listConflicts(userA)).find(
      (conflict) => conflict.status === "open",
    );
    if (!unhydrated) throw new Error("missing quarantined conflict");
    await expect(repository.resolveLocalConflict(
      userA,
      unhydrated.id,
      "accept-server",
    )).rejects.toMatchObject({ code: "VECTOR_CONFLICT_BRANCH_INVALID" });
    await repository.applyBootstrap(userA, DEVICE, bootstrapResponse([remote]));
    const conflicts = (await repository.listConflicts(userA)).filter(
      (conflict) => conflict.status === "open",
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      reason: "local_checksum_mismatch",
      server: { state: trusted, serverRevision: 1 },
    });
    await repository.resolveLocalConflict(userA, conflicts[0].id, "accept-server");
    expect((await repository.listConflicts(userA)).filter(
      (conflict) => conflict.status === "open",
    )).toHaveLength(0);
    expect(await repository.loadSave(userA, "second-sense", "main")).toMatchObject({
      state: trusted,
      syncState: "synced",
    });
  });

  it("preserves newer, missing, and failing migration sources as non-hydratable conflicts", async () => {
    await repository.activateOwner(userA);
    const reasons = [
      "save_schema_newer",
      "save_migrator_missing",
      "save_migration_failed",
    ] as const;
    for (const [index, reason] of reasons.entries()) {
      const slotId = `migration-${index}`;
      const source = await repository.saveLocal({
        ownerKey: userA,
        gameId: "second-sense",
        slotId,
        gameVersion: "1.0.0",
        saveSchemaVersion: index + 1,
        deviceId: DEVICE,
        seed: null,
        state: { source: reason },
      });
      const conflict = await repository.quarantineMigrationFailure(
        userA,
        "second-sense",
        slotId,
        reason,
        { localRevision: source.localRevision, checksum: source.checksum },
      );
      await expect(repository.resolveLocalConflict(
        userA,
        conflict.id,
        "accept-local",
      )).rejects.toMatchObject({ code: "VECTOR_CONFLICT_BRANCH_INVALID" });
      expect(await db.saves.get(source.id)).toMatchObject({
        state: { source: reason },
        syncState: "conflict",
        lastErrorCode: reason.toUpperCase(),
      });
    }
    expect((await repository.listConflicts(userA)).filter(
      (conflict) => conflict.status === "open",
    )).toHaveLength(3);
  });

  it("refuses to quarantine a newer save than the failed migration ancestor", async () => {
    await repository.activateOwner(userA);
    const failed = await repository.saveLocal({
      ownerKey: userA,
      gameId: "second-sense",
      slotId: "migration-race",
      gameVersion: "1.0.0",
      saveSchemaVersion: 1,
      deviceId: DEVICE,
      seed: null,
      state: { branch: "failed-source" },
    });
    const newer = await repository.saveLocal({
      ownerKey: userA,
      gameId: "second-sense",
      slotId: "migration-race",
      gameVersion: "1.0.0",
      saveSchemaVersion: 2,
      deviceId: DEVICE,
      seed: null,
      state: { branch: "newer-current" },
    });
    await expect(repository.quarantineMigrationFailure(
      userA,
      "second-sense",
      "migration-race",
      "save_migration_failed",
      { localRevision: failed.localRevision, checksum: failed.checksum },
    )).rejects.toMatchObject({ code: "VECTOR_CONFLICT_VERSION_MISMATCH" });
    expect(await repository.loadSave(userA, "second-sense", "migration-race"))
      .toMatchObject({
        localRevision: newer.localRevision,
        state: newer.state,
        syncState: "pending",
      });
    expect(await repository.listConflicts(userA, "second-sense")).toHaveLength(0);
  });

  it("retries a quarantined migration with conflict and ancestor CAS", async () => {
    await repository.activateOwner(userA);
    const source = await repository.saveLocal({
      ownerKey: userA,
      gameId: "second-sense",
      slotId: "migration-retry",
      gameVersion: "1.0.0",
      saveSchemaVersion: 1,
      deviceId: DEVICE,
      seed: "legacy",
      state: { legacy: true },
    });
    const conflict = await repository.quarantineMigrationFailure(
      userA,
      "second-sense",
      "migration-retry",
      "save_migration_failed",
      { localRevision: source.localRevision, checksum: source.checksum },
    );
    await db.conflicts.update(conflict.id, { conflictVersion: 2 });
    const retry = {
      ownerKey: userA,
      gameId: "second-sense" as const,
      slotId: "migration-retry",
      gameVersion: "1.1.0",
      saveSchemaVersion: 2,
      deviceId: DEVICE,
      seed: "legacy",
      state: { legacy: false, migrated: true },
      conflictId: conflict.id,
      expectedConflictVersion: conflict.conflictVersion,
      expectedAncestor: {
        localRevision: source.localRevision,
        checksum: source.checksum,
      },
    };
    await expect(repository.retryMigrationFailure(retry)).rejects.toMatchObject({
      code: "VECTOR_CONFLICT_VERSION_MISMATCH",
    });
    await db.conflicts.update(conflict.id, { conflictVersion: conflict.conflictVersion });
    const result = await repository.retryMigrationFailure(retry);
    expect(result).toMatchObject({
      save: {
        localRevision: 2,
        saveSchemaVersion: 2,
        state: retry.state,
        syncState: "pending",
      },
      conflict: {
        status: "resolved",
        resolution: "accept-local",
        conflictVersion: 2,
      },
    });
    expect(await repository.loadSave(userA, "second-sense", "migration-retry"))
      .toMatchObject({ state: retry.state, integrityChecksum: expect.any(String) });
  });

  it("rolls back a failed migration retry without resolving or erasing its source", async () => {
    await repository.activateOwner(userA);
    const source = await repository.saveLocal({
      ownerKey: userA,
      gameId: "second-sense",
      slotId: "migration-rollback",
      gameVersion: "1.0.0",
      saveSchemaVersion: 1,
      deviceId: DEVICE,
      seed: null,
      state: { source: "preserved" },
    });
    const conflict = await repository.quarantineMigrationFailure(
      userA,
      "second-sense",
      "migration-rollback",
      "save_migrator_missing",
      { localRevision: source.localRevision, checksum: source.checksum },
    );
    const quotaError = Object.assign(new Error("full"), { name: "QuotaExceededError" });
    vi.spyOn(db.saves, "put").mockRejectedValueOnce(quotaError);
    await expect(repository.retryMigrationFailure({
      ownerKey: userA,
      gameId: "second-sense",
      slotId: "migration-rollback",
      gameVersion: "1.1.0",
      saveSchemaVersion: 2,
      deviceId: DEVICE,
      seed: null,
      state: { source: "migrated" },
      conflictId: conflict.id,
      expectedConflictVersion: conflict.conflictVersion,
      expectedAncestor: {
        localRevision: source.localRevision,
        checksum: source.checksum,
      },
    })).rejects.toMatchObject({ code: "VECTOR_LOCAL_QUOTA_EXCEEDED" });
    expect(await db.saves.get(source.id)).toMatchObject({
      localRevision: source.localRevision,
      state: source.state,
      syncState: "conflict",
    });
    expect(await db.conflicts.get(conflict.id)).toMatchObject({
      status: "open",
      conflictVersion: conflict.conflictVersion,
    });
  });

  it("quarantines cyclic malformed state without crashing or erasing the source row", async () => {
    await repository.activateOwner(userA);
    const source = await repository.saveLocal({
      ownerKey: userA,
      gameId: "second-sense",
      slotId: "cyclic",
      gameVersion: "1.0.0",
      saveSchemaVersion: 1,
      deviceId: DEVICE,
      seed: null,
      state: { valid: true },
    });
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    await db.saves.update(source.id, { state: cyclic as never });
    await expect(repository.listVerifiedSaves(userA)).resolves.toMatchObject({
      saves: [],
      quarantined: 1,
      unscopedQuarantined: 0,
    });
    expect(await repository.listConflicts(userA)).toMatchObject([{
      reason: "local_checksum_mismatch",
      local: { state: { quarantined: true, rawStateExportUnavailable: true } },
    }]);
    const raw = await db.saves.get(source.id);
    expect(Array.isArray(raw?.state)).toBe(true);
    expect((raw?.state as unknown[])[0]).toBe(raw?.state);
  });

  it("hydrates namespaced score and achievement truth from bootstrap", async () => {
    await repository.activateOwner(userA);
    const response = bootstrapResponse([]);
    response.scores = [{
      gameId: "second-sense",
      mode: "solo",
      challengeId: null,
      score: 42,
      verificationStatus: "unverified",
      updatedAt: new Date().toISOString(),
    }];
    response.achievements = [{
      gameId: "second-sense",
      achievementId: "first-run",
      unlockedAt: new Date().toISOString(),
    }];
    await repository.applyBootstrap(userA, DEVICE, response);
    expect(await repository.loadProfile(userA)).toMatchObject({
      scores: { "second-sense:solo:": 42 },
      unlocks: ["second-sense:first-run"],
    });
  });

  it("applies a counter optimistically once and does not double-add on duplicate ack", async () => {
    await repository.activateOwner(userA);
    await repository.ensureProfile(userA, DEVICE);
    const event = {
      kind: "counter" as const,
      idempotencyKey: crypto.randomUUID(),
      localRevision: 1,
      occurredAt: new Date().toISOString(),
      payload: { counterId: "plays", delta: 5 },
    };
    await repository.enqueueEvent(userA, "second-sense", event);
    await repository.enqueueEvent(userA, "second-sense", event);
    expect(await repository.loadProfile(userA)).toMatchObject({
      counters: { "second-sense:plays": 5 },
    });
    const bootstrap = bootstrapResponse([]);
    bootstrap.profile = {
      settings: {},
      settingClocks: {},
      unlocks: [],
      counters: { "second-sense:plays": 5 },
      serverRevision: 1,
      updatedAt: new Date().toISOString(),
    };
    await repository.applyBootstrap(userA, DEVICE, bootstrap);
    const snapshot = await repository.createSyncSnapshot(userA, "second-sense", DEVICE);
    if (!snapshot) throw new Error("missing counter snapshot");
    await repository.applySyncResponse(userA, snapshot, {
      partial: false,
      results: [{
        idempotencyKey: event.idempotencyKey,
        kind: "counter",
        status: "duplicate",
        code: null,
        slotId: null,
        localRevision: 1,
        serverRevision: 1,
        conflictId: null,
        authoritativeValue: 5,
      }],
      saves: [],
      conflicts: [],
      truncated: { saves: false, conflicts: false },
      serverTime: new Date().toISOString(),
    });
    expect(await repository.loadProfile(userA)).toMatchObject({
      counters: { "second-sense:plays": 5 },
    });
    expect(await repository.listOutbox(userA)).toHaveLength(0);
  });

  it("preserves a counter delta queued after an earlier sync snapshot", async () => {
    await repository.activateOwner(userA);
    await repository.ensureProfile(userA, DEVICE);
    const first = {
      kind: "counter" as const,
      idempotencyKey: crypto.randomUUID(),
      localRevision: 1,
      occurredAt: new Date().toISOString(),
      payload: { counterId: "plays", delta: 5 },
    };
    await repository.enqueueEvent(userA, "second-sense", first);
    const snapshot = await repository.createSyncSnapshot(userA, "second-sense", DEVICE);
    if (!snapshot) throw new Error("missing counter snapshot");
    const second = {
      ...first,
      idempotencyKey: crypto.randomUUID(),
      localRevision: 2,
      payload: { counterId: "plays", delta: 2 },
    };
    await repository.enqueueEvent(userA, "second-sense", second);
    await repository.applySyncResponse(userA, snapshot, {
      partial: false,
      results: [{
        idempotencyKey: first.idempotencyKey,
        kind: "counter",
        status: "applied",
        code: null,
        slotId: null,
        localRevision: 1,
        serverRevision: 1,
        conflictId: null,
        // Another tab may already have applied the second delta on the server.
        authoritativeValue: 7,
      }],
      saves: [],
      conflicts: [],
      truncated: { saves: false, conflicts: false },
      serverTime: new Date().toISOString(),
    });
    expect(await repository.loadProfile(userA)).toMatchObject({
      counters: { "second-sense:plays": 7 },
    });
    expect(await repository.listOutbox(userA)).toMatchObject([{
      id: second.idempotencyKey,
      status: "pending",
    }]);
  });

  it("rejects optimistic counter overflow atomically", async () => {
    await repository.activateOwner(userA);
    await repository.ensureProfile(userA, DEVICE);
    await db.profiles.update(userA, {
      counters: { "second-sense:plays": Number.MAX_SAFE_INTEGER },
    });
    await expect(repository.enqueueEvent(userA, "second-sense", {
      kind: "counter",
      idempotencyKey: crypto.randomUUID(),
      localRevision: 1,
      occurredAt: new Date().toISOString(),
      payload: { counterId: "plays", delta: 1 },
    })).rejects.toMatchObject({ code: "VECTOR_COUNTER_OVERFLOW" });
    expect(await repository.listOutbox(userA)).toHaveLength(0);
    expect(await repository.loadProfile(userA)).toMatchObject({
      counters: { "second-sense:plays": Number.MAX_SAFE_INTEGER },
    });
  });

  it("rejects cumulative profile growth atomically at the 16 KiB boundary", async () => {
    await repository.activateOwner(userA);
    await repository.ensureProfile(userA, DEVICE);
    const target = "second-sense:overflow";
    const counters: Record<string, number> = {};
    for (let index = 0; index < 1_749; index += 1) counters[`p${index}`] = 0;
    expect(vectorJsonBytes(counters)).toBeLessThanOrEqual(VECTOR_PROFILE_MAX_DOCUMENT_BYTES);
    expect(vectorJsonBytes({ ...counters, [target]: 1 })).toBeGreaterThan(
      VECTOR_PROFILE_MAX_DOCUMENT_BYTES,
    );
    await db.profiles.update(userA, { counters });
    const idempotencyKey = crypto.randomUUID();

    await expect(repository.enqueueEvent(userA, "second-sense", {
      kind: "counter",
      idempotencyKey,
      localRevision: 1,
      occurredAt: new Date().toISOString(),
      payload: { counterId: "overflow", delta: 1 },
    })).rejects.toMatchObject({ code: "VECTOR_PROFILE_TOO_LARGE" });

    expect(await db.outbox.get(idempotencyKey)).toBeUndefined();
    expect((await repository.loadProfile(userA))?.counters).toEqual(counters);
  });

  it("rejects cross-game sync refresh data before mutating IndexedDB", async () => {
    await repository.activateOwner(userA);
    await repository.saveLocal({
      ownerKey: userA,
      gameId: "second-sense",
      slotId: "main",
      gameVersion: "1.0.0",
      saveSchemaVersion: 1,
      deviceId: DEVICE,
      seed: null,
      state: { local: true },
    });
    const snapshot = await repository.createSyncSnapshot(userA, "second-sense", DEVICE);
    if (!snapshot) throw new Error("missing snapshot");
    const injected = { injected: true };
    await expect(repository.applySyncResponse(userA, snapshot, {
      partial: false,
      results: [],
      saves: [{
        gameId: "brickrise",
        slotId: "injected",
        gameVersion: "1.0.0",
        saveSchemaVersion: 1,
        serverRevision: 1,
        clientRevision: 1,
        deviceId: "device-remote-1",
        checksum: await checksumVectorState(injected),
        seed: null,
        state: injected,
        updatedAt: new Date().toISOString(),
        deletedAt: null,
      }],
      conflicts: [],
      truncated: { saves: false, conflicts: false },
      serverTime: new Date().toISOString(),
    })).rejects.toMatchObject({ code: "VECTOR_SYNC_RESPONSE_SCOPE_INVALID" });
    expect(await db.saves.where("gameId").equals("brickrise").count()).toBe(0);
  });

  it("rejects duplicate sync result identities before applying either result", async () => {
    await repository.activateOwner(userA);
    await repository.saveLocal({
      ownerKey: userA,
      gameId: "second-sense",
      slotId: "main",
      gameVersion: "1.0.0",
      saveSchemaVersion: 1,
      deviceId: DEVICE,
      seed: null,
      state: { local: true },
    });
    const snapshot = await repository.createSyncSnapshot(userA, "second-sense", DEVICE);
    if (!snapshot) throw new Error("missing snapshot");
    const sent = snapshot.transmittedSaves[0];
    const base = {
      idempotencyKey: sent.idempotencyKey,
      kind: "save" as const,
      code: null,
      slotId: sent.slotId,
      localRevision: sent.localRevision,
      serverRevision: 1,
      conflictId: null,
    };
    await expect(repository.applySyncResponse(userA, snapshot, {
      partial: true,
      results: [
        { ...base, status: "applied" },
        { ...base, status: "rejected", code: "VECTOR_SAVE_REJECTED" },
      ],
      saves: [],
      conflicts: [],
      truncated: { saves: false, conflicts: false },
      serverTime: new Date().toISOString(),
    })).rejects.toMatchObject({ code: "VECTOR_SYNC_RESPONSE_DUPLICATE_RESULT" });
    expect(await db.saves.get(`user:${USER_A}|second-sense|main`)).toMatchObject({
      serverRevision: 0,
      syncState: "syncing",
    });
  });

  it("binds cloud conflict application to branch identity and allowed slots", async () => {
    await repository.activateOwner(userA);
    const localState = { branch: "local" };
    const serverState = { branch: "server" };
    const local = await repository.saveLocal({
      ownerKey: userA,
      gameId: "second-sense",
      slotId: "main",
      gameVersion: "1.0.0",
      saveSchemaVersion: 1,
      deviceId: DEVICE,
      seed: null,
      state: localState,
    });
    const conflictId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const openConflict = {
      id: conflictId,
      ownerKey: userA,
      authority: "cloud" as const,
      gameId: "second-sense" as const,
      slotId: "main",
      reason: "revision_mismatch",
      conflictVersion: 1,
      status: "open" as const,
      resolution: null,
      local: {
        localRevision: local.localRevision,
        gameVersion: local.gameVersion,
        saveSchemaVersion: local.saveSchemaVersion,
        checksum: local.checksum,
        seed: null,
        state: localState,
        updatedAt: local.updatedAt,
      },
      server: {
        serverRevision: 1,
        gameVersion: "1.0.0",
        saveSchemaVersion: 1,
        checksum: await checksumVectorState(serverState),
        seed: null,
        state: serverState,
        updatedAt: createdAt,
      },
      createdAt,
      resolvedAt: null,
    };
    await db.conflicts.put(openConflict);
    await db.saves.update(local.id, { syncState: "conflict" });
    const truncatedBootstrap = bootstrapResponse([]);
    truncatedBootstrap.truncated.saves = true;
    await repository.applyBootstrap(userA, DEVICE, truncatedBootstrap);
    expect(await db.conflicts.get(conflictId)).toMatchObject({ status: "open" });
    const resolved = {
      ...openConflict,
      conflictVersion: 2,
      status: "resolved" as const,
      resolution: "accept-server" as const,
      resolvedAt: new Date().toISOString(),
    };
    const remoteSave = {
      gameId: "second-sense" as const,
      slotId: "main",
      gameVersion: "1.0.0",
      saveSchemaVersion: 1,
      serverRevision: 1,
      clientRevision: 1,
      deviceId: "device-remote-1",
      checksum: await checksumVectorState(serverState),
      seed: null,
      state: serverState,
      updatedAt: createdAt,
      deletedAt: null,
    };
    const resolvedBranch = {
      slotId: "main",
      deleted: false,
      serverRevision: 1,
      clientRevision: 1,
      gameVersion: "1.0.0",
      saveSchemaVersion: 1,
      checksum: remoteSave.checksum,
      seed: null,
    };
    await expect(repository.applyCloudConflictResolution(
      userA,
      resolved,
      [{ ...remoteSave, slotId: "injected" }],
      { resolution: "accept-server", resolvedBranch },
    )).rejects.toMatchObject({ code: "VECTOR_SYNC_RESPONSE_SCOPE_INVALID" });
    await expect(repository.applyCloudConflictResolution(
      userA,
      resolved,
      [remoteSave],
      {
        resolution: "accept-server",
        resolvedBranch: { ...resolvedBranch, checksum: "f".repeat(64) },
      },
    )).rejects.toMatchObject({ code: "VECTOR_CONFLICT_BRANCH_INVALID" });
    expect(await db.conflicts.get(conflictId)).toMatchObject({ status: "open" });
    expect(await repository.loadSave(userA, "second-sense", "main")).toMatchObject({
      state: localState,
      syncState: "conflict",
    });
    const newerState = { branch: "server-newer" };
    const newerSave = {
      ...remoteSave,
      serverRevision: 2,
      clientRevision: 2,
      checksum: await checksumVectorState(newerState),
      state: newerState,
      updatedAt: new Date(Date.parse(createdAt) + 1_000).toISOString(),
    };
    await expect(repository.applyCloudConflictResolution(
      userA,
      resolved,
      [newerSave],
      { resolution: "accept-server", resolvedBranch },
    )).resolves.toMatchObject({ status: "resolved" });
    await expect(repository.applyCloudConflictResolution(
      userA,
      resolved,
      [newerSave],
      { resolution: "accept-server", resolvedBranch },
    )).resolves.toMatchObject({ status: "resolved" });
    expect(await repository.loadSave(userA, "second-sense", "main")).toMatchObject({
      state: newerState,
      serverRevision: 2,
      syncState: "synced",
    });
  });
});
