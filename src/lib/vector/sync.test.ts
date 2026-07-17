import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  VectorDatabase,
  VectorPersistence,
  vectorUserOwner,
} from "@/lib/vector/persistence";
import {
  bootstrapVectorCloud,
  resolveVectorCloudConflict,
  syncVectorGame,
} from "@/lib/vector/sync";

const owner = vectorUserOwner("11111111-1111-4111-8111-111111111111");
const otherOwner = vectorUserOwner("22222222-2222-4222-8222-222222222222");
const deviceId = "device-12345678";
let db: VectorDatabase;
let persistence: VectorPersistence;

beforeEach(async () => {
  db = new VectorDatabase(`axis-vector-sync-test-${crypto.randomUUID()}`);
  persistence = new VectorPersistence(db);
  await db.open();
  await persistence.activateOwner(owner);
  await persistence.saveLocal({
    ownerKey: owner,
    gameId: "second-sense",
    slotId: "main",
    gameVersion: "1.0.0",
    saveSchemaVersion: 1,
    deviceId,
    seed: null,
    state: { round: 1 },
  });
});

afterEach(async () => {
  db.close();
  await db.delete();
});

describe("VECTOR sync client", () => {
  it("applies an authenticated sync acknowledgement", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return Response.json({
        partial: false,
        results: [{
          idempotencyKey: body.saves[0].idempotencyKey,
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
        serverTime: new Date().toISOString(),
      });
    }) as typeof fetch;
    await expect(syncVectorGame({
      repository: persistence,
      ownerKey: owner,
      gameId: "second-sense",
      deviceId,
      fetcher,
    })).resolves.toMatchObject({ status: "synced" });
    expect(await persistence.loadSave(owner, "second-sense", "main")).toMatchObject({
      serverRevision: 1,
      syncState: "synced",
    });
  });

  it("keeps local state pending with a visible code when transport fails", async () => {
    const result = await syncVectorGame({
      repository: persistence,
      ownerKey: owner,
      gameId: "second-sense",
      deviceId,
      fetcher: vi.fn(async () => {
        throw new Error("offline");
      }) as typeof fetch,
    });
    expect(result).toEqual({
      status: "error",
      code: "VECTOR_SYNC_NETWORK",
      retryable: true,
    });
    expect(await persistence.loadSave(owner, "second-sense", "main")).toMatchObject({
      syncState: "error",
      lastErrorCode: "VECTOR_SYNC_NETWORK",
    });
  });

  it("quarantines envelope corruption at the direct sync boundary without POSTing", async () => {
    const stored = await persistence.loadSave(owner, "second-sense", "main");
    if (!stored) throw new Error("missing save");
    await db.saves.update(stored.id, { seed: "tampered-seed" });
    const fetcher = vi.fn() as unknown as typeof fetch;
    await expect(syncVectorGame({
      repository: persistence,
      ownerKey: owner,
      gameId: "second-sense",
      deviceId,
      fetcher,
    })).resolves.toEqual({ status: "idle" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await persistence.listVerifiedSaves(owner, "second-sense")).toMatchObject({
      saves: [],
      quarantined: 1,
    });
    expect(await persistence.listConflicts(owner, "second-sense")).toMatchObject([{
      reason: "local_checksum_mismatch",
      status: "open",
    }]);
  });

  it("reports partial truth when the server rejects one transmitted record", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return Response.json({
        partial: true,
        results: [{
          idempotencyKey: body.saves[0].idempotencyKey,
          kind: "save",
          status: "rejected",
          code: "VECTOR_SAVE_SYNC_FAILED",
          slotId: "main",
          localRevision: 1,
          serverRevision: null,
          conflictId: null,
        }],
        saves: [],
        conflicts: [],
        serverTime: new Date().toISOString(),
      });
    }) as typeof fetch;

    await expect(syncVectorGame({
      repository: persistence,
      ownerKey: owner,
      gameId: "second-sense",
      deviceId,
      fetcher,
    })).resolves.toMatchObject({
      status: "partial",
      code: "VECTOR_SYNC_PARTIAL",
    });
    expect(await persistence.loadSave(owner, "second-sense", "main")).toMatchObject({
      syncState: "error",
      lastErrorCode: "VECTOR_SAVE_SYNC_FAILED",
    });
  });

  it("defends against a false non-partial CAS-conflict response", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return Response.json({
        partial: false,
        results: [{
          idempotencyKey: body.saves[0].idempotencyKey,
          kind: "save",
          status: "conflict",
          code: "VECTOR_SAVE_CONFLICT",
          slotId: "main",
          localRevision: 1,
          serverRevision: 1,
          conflictId: "33333333-3333-4333-8333-333333333333",
        }],
        saves: [],
        conflicts: [],
        truncated: { saves: false, conflicts: false },
        serverTime: new Date().toISOString(),
      });
    }) as typeof fetch;
    await expect(syncVectorGame({
      repository: persistence,
      ownerKey: owner,
      gameId: "second-sense",
      deviceId,
      fetcher,
    })).resolves.toMatchObject({ status: "partial", code: "VECTOR_SYNC_PARTIAL" });
  });

  it("drains more than one save/event batch before claiming synced", async () => {
    for (let index = 1; index < 5; index += 1) {
      await persistence.saveLocal({
        ownerKey: owner,
        gameId: "second-sense",
        slotId: `slot-${index}`,
        gameVersion: "1.0.0",
        saveSchemaVersion: 1,
        deviceId,
        seed: null,
        state: { index },
      });
    }
    for (let index = 0; index < 65; index += 1) {
      await persistence.enqueueEvent(owner, "second-sense", {
        kind: "score",
        idempotencyKey: crypto.randomUUID(),
        localRevision: index + 1,
        occurredAt: new Date().toISOString(),
        payload: { mode: "solo", challengeId: null, value: index },
      });
    }
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return Response.json({
        partial: false,
        results: [
          ...body.saves.map((save: { idempotencyKey: string; slotId: string; localRevision: number }) => ({
            idempotencyKey: save.idempotencyKey,
            kind: "save",
            status: "applied",
            code: null,
            slotId: save.slotId,
            localRevision: save.localRevision,
            serverRevision: 1,
            conflictId: null,
          })),
          ...body.events.map((event: { idempotencyKey: string; kind: string; localRevision: number }) => ({
            idempotencyKey: event.idempotencyKey,
            kind: event.kind,
            status: "applied",
            code: null,
            slotId: null,
            localRevision: event.localRevision,
            serverRevision: null,
            conflictId: null,
          })),
        ],
        saves: [],
        conflicts: [],
        truncated: { saves: false, conflicts: false },
        serverTime: new Date().toISOString(),
      });
    }) as typeof fetch;
    await expect(syncVectorGame({
      repository: persistence,
      ownerKey: owner,
      gameId: "second-sense",
      deviceId,
      fetcher,
    })).resolves.toMatchObject({ status: "synced" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(await persistence.countPendingSyncWork(owner, "second-sense")).toBe(0);
  }, 15_000);

  it("does not mutate a departed owner namespace when auth changes in flight", async () => {
    let releaseResponse: (() => void) | undefined;
    const responseReady = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      await responseReady;
      const body = JSON.parse(String(init?.body));
      return Response.json({
        partial: false,
        results: [{
          idempotencyKey: body.saves[0].idempotencyKey,
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
        serverTime: new Date().toISOString(),
      });
    }) as typeof fetch;
    const sync = syncVectorGame({
      repository: persistence,
      ownerKey: owner,
      gameId: "second-sense",
      deviceId,
      fetcher,
    });
    await vi.waitFor(async () => {
      expect((await db.saves.where("ownerKey").equals(owner).first())?.syncState).toBe("syncing");
    });
    await persistence.activateOwner(otherOwner);
    releaseResponse?.();
    await expect(sync).resolves.toEqual({
      status: "error",
      code: "VECTOR_OWNER_CHANGED",
      retryable: false,
    });
    expect((await db.saves.where("ownerKey").equals(owner).first())?.syncState).toBe("pending");
  });

  it("reports a truncated bootstrap as partial, never fully loaded", async () => {
    await expect(bootstrapVectorCloud({
      persistence,
      ownerKey: owner,
      deviceId,
      fetcher: vi.fn(async () => Response.json({
        profile: null,
        saves: [],
        scores: [],
        achievements: [],
        conflicts: [],
        truncated: { saves: true, scores: false, achievements: false, conflicts: false },
        serverTime: new Date().toISOString(),
      })) as typeof fetch,
    })).resolves.toMatchObject({
      status: "partial",
      code: "VECTOR_BOOTSTRAP_PARTIAL",
    });
  });
});

describe("VECTOR conflict client", () => {
  it("validates and returns a resolved cloud conflict", async () => {
    const conflictId = "33333333-3333-4333-8333-333333333333";
    const idempotencyKey = "44444444-4444-4444-8444-444444444444";
    const fetcher = vi.fn(async () => Response.json({
      result: {
        idempotencyKey,
        kind: "save",
        status: "applied",
        code: null,
        slotId: "main",
        localRevision: 2,
        serverRevision: 1,
        conflictId,
        resolvedBranch: {
          slotId: "main",
          deleted: false,
          serverRevision: 1,
          clientRevision: 1,
          gameVersion: "1.0.0",
          saveSchemaVersion: 1,
          checksum: "2".repeat(64),
          seed: null,
        },
      },
      conflict: {
        id: conflictId,
        gameId: "second-sense",
        slotId: "main",
        reason: "revision_mismatch",
        conflictVersion: 2,
        status: "resolved",
        resolution: "accept-server",
        local: {
          localRevision: 2,
          gameVersion: "1.0.0",
          saveSchemaVersion: 1,
          checksum: "1".repeat(64),
          seed: null,
          state: { round: 2 },
          updatedAt: "2026-07-16T10:00:00.000Z",
        },
        server: {
          serverRevision: 1,
          gameVersion: "1.0.0",
          saveSchemaVersion: 1,
          checksum: "2".repeat(64),
          seed: null,
          state: { round: 1 },
          updatedAt: "2026-07-16T09:00:00.000Z",
        },
        createdAt: "2026-07-16T10:00:00.000Z",
        resolvedAt: "2026-07-16T10:01:00.000Z",
      },
      saves: [],
    })) as typeof fetch;

    await expect(resolveVectorCloudConflict({
      conflictId,
      idempotencyKey,
      resolution: {
        expectedConflictVersion: 1,
        resolution: "accept-server",
      },
      fetcher,
    })).resolves.toMatchObject({ status: "resolved" });
    expect(fetcher).toHaveBeenCalledWith(
      `/api/vector/conflicts/${conflictId}`,
      expect.objectContaining({ method: "PATCH", credentials: "same-origin" }),
    );
  });

  it("preserves a safe server conflict code and retryability", async () => {
    await expect(resolveVectorCloudConflict({
      conflictId: "33333333-3333-4333-8333-333333333333",
      idempotencyKey: "44444444-4444-4444-8444-444444444444",
      resolution: {
        expectedConflictVersion: 1,
        resolution: "accept-server",
      },
      fetcher: vi.fn(async () => Response.json(
        { error: "VECTOR_CONFLICT_VERSION_MISMATCH" },
        { status: 409 },
      )) as typeof fetch,
    })).resolves.toEqual({
      status: "error",
      code: "VECTOR_CONFLICT_VERSION_MISMATCH",
      retryable: false,
    });
  });
});
