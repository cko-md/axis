import { describe, expect, it, vi } from "vitest";
import type { VectorLocalConflict, VectorOwnerKey } from "@/lib/vector/persistence-types";
import type { VectorConflictResolutionOutcome } from "@/lib/vector/sync";
import {
  assertVectorOwnerEpoch,
  executeVectorConflictResolution,
  getOrCreateVectorConflictResolutionKey,
  hasUnscopedVectorQuarantine,
  prepareVectorMigrationRetry,
  publishVectorLocalState,
  selectVectorStateBootstrapGames,
  vectorPlatformErrorCode,
} from "@/hooks/useVectorPlatform";

const OWNER = "user:11111111-1111-4111-8111-111111111111" as VectorOwnerKey;
const NOW = "2026-07-16T12:00:00.000Z";

function conflict(authority: VectorLocalConflict["authority"]): VectorLocalConflict {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    ownerKey: OWNER,
    authority,
    gameId: "second-sense",
    slotId: "main",
    reason: authority === "local" ? "local_checksum_mismatch" : "revision_mismatch",
    conflictVersion: 1,
    status: "open",
    resolution: null,
    local: {
      localRevision: 2,
      gameVersion: "1.0.0",
      saveSchemaVersion: 1,
      checksum: "a".repeat(64),
      seed: null,
      state: { round: 2 },
      updatedAt: NOW,
    },
    server: {
      serverRevision: 1,
      gameVersion: "1.0.0",
      saveSchemaVersion: 1,
      checksum: "b".repeat(64),
      seed: null,
      state: { round: 1 },
      updatedAt: NOW,
    },
    createdAt: NOW,
    resolvedAt: null,
  };
}

function repository(activeOwner: VectorOwnerKey = OWNER) {
  return {
    getActiveOwner: vi.fn(() => activeOwner),
    resolveLocalConflict: vi.fn(async () => conflict("local")),
    applyCloudConflictResolution: vi.fn(async () => conflict("cloud")),
  };
}

describe("VECTOR conflict workflow", () => {
  it("surfaces quarantined rows that cannot be represented by a safe conflict", () => {
    expect(hasUnscopedVectorQuarantine(0)).toBe(false);
    expect(hasUnscopedVectorQuarantine(1)).toBe(true);
  });

  it("requests private state only for games with local work or remote branches", () => {
    expect(selectVectorStateBootstrapGames({
      pendingGames: ["paper-glider"],
      remoteSaveGames: ["second-sense", "paper-glider"],
      remoteConflictGames: ["mini-town"],
    })).toEqual(["second-sense", "paper-glider", "mini-town"]);
    expect(selectVectorStateBootstrapGames({
      pendingGames: [],
      remoteSaveGames: [],
      remoteConflictGames: [],
    })).toEqual([]);
  });

  it("rejects a delayed serializer after the owner epoch changes", async () => {
    let finishSerialize: (() => void) | undefined;
    const delayedSerialize = new Promise<void>((resolve) => {
      finishSerialize = resolve;
    });
    let currentOwner = OWNER;
    let currentEpoch = 7;
    const oldOwner = currentOwner;
    const oldEpoch = currentEpoch;

    const lateWrite = delayedSerialize.then(() => {
      assertVectorOwnerEpoch(currentOwner, currentEpoch, oldOwner, oldEpoch);
    });
    currentOwner = "user:44444444-4444-4444-8444-444444444444";
    currentEpoch += 1;
    finishSerialize?.();

    await expect(lateWrite).rejects.toThrow("VECTOR_OWNER_CHANGED");
  });

  it("normalizes browser storage failures without exposing arbitrary messages", () => {
    const missing = new Error("IndexedDB API missing in this browser");
    missing.name = "MissingAPIError";
    const quota = new Error("Synthetic storage boundary");
    quota.name = "QuotaExceededError";

    expect(vectorPlatformErrorCode(missing)).toBe("VECTOR_INDEXEDDB_UNAVAILABLE");
    expect(vectorPlatformErrorCode(quota)).toBe("VECTOR_LOCAL_QUOTA_EXCEEDED");
    expect(vectorPlatformErrorCode(new Error("database host internal.example failed")))
      .toBe("VECTOR_LOCAL_UNKNOWN");
    expect(vectorPlatformErrorCode(new Error("VECTOR_CONFLICT_NETWORK")))
      .toBe("VECTOR_CONFLICT_NETWORK");
  });

  it("retries only preserved migration conflicts through an explicit pure migrator", () => {
    const quarantined = {
      ...conflict("local"),
      reason: "save_migrator_missing",
      local: {
        ...conflict("local").local,
        seed: "",
      },
    };
    expect(prepareVectorMigrationRetry(quarantined, 2, [{
      from: 1,
      to: 2,
      migrate: (state) => ({ ...(state as object), migrated: true }),
    }])).toEqual({
      schemaVersion: 2,
      data: { round: 2, migrated: true },
      seed: "",
    });
    expect(() => prepareVectorMigrationRetry(
      { ...quarantined, reason: "revision_mismatch" },
      2,
      [],
    )).toThrow("VECTOR_MIGRATION_RETRY_NOT_ALLOWED");
    expect(() => prepareVectorMigrationRetry(quarantined, 2, []))
      .toThrow("VECTOR_SAVE_MIGRATOR_MISSING");
  });

  it("reuses one idempotency key for retries and rotates it when intent changes", () => {
    const keys = new Map();
    const createKey = vi
      .fn<() => string>()
      .mockReturnValueOnce("33333333-3333-4333-8333-333333333333")
      .mockReturnValueOnce("44444444-4444-4444-8444-444444444444");

    expect(getOrCreateVectorConflictResolutionKey(
      keys,
      "22222222-2222-4222-8222-222222222222",
      "accept-server",
      undefined,
      createKey,
    )).toBe("33333333-3333-4333-8333-333333333333");
    expect(getOrCreateVectorConflictResolutionKey(
      keys,
      "22222222-2222-4222-8222-222222222222",
      "accept-server",
      undefined,
      createKey,
    )).toBe("33333333-3333-4333-8333-333333333333");
    expect(createKey).toHaveBeenCalledTimes(1);

    expect(getOrCreateVectorConflictResolutionKey(
      keys,
      "22222222-2222-4222-8222-222222222222",
      "fork-local",
      "main-fork",
      createKey,
    )).toBe("44444444-4444-4444-8444-444444444444");
    expect(createKey).toHaveBeenCalledTimes(2);
  });

  it("publishes local owner state without coupling it to cloud reconciliation", async () => {
    const readLocal = vi.fn<() => Promise<string>>().mockResolvedValue("local");
    const publishLocal = vi.fn();
    const published = await publishVectorLocalState({
      readLocal,
      publishLocal,
    });

    expect(published).toBe("local");
    expect(publishLocal).toHaveBeenCalledWith("local");
    expect(readLocal).toHaveBeenCalledTimes(1);
  });

  it("resolves local authority without requiring a network call", async () => {
    const repo = repository();
    const resolveCloud = vi.fn();

    await expect(executeVectorConflictResolution({
      repository: repo,
      ownerKey: OWNER,
      conflict: conflict("local"),
      resolution: "accept-server",
      idempotencyKey: "33333333-3333-4333-8333-333333333333",
      resolveCloud,
    })).resolves.toEqual({ status: "resolved-local" });

    expect(repo.resolveLocalConflict).toHaveBeenCalledWith(
      OWNER,
      "22222222-2222-4222-8222-222222222222",
      "accept-server",
      undefined,
    );
    expect(resolveCloud).not.toHaveBeenCalled();
  });

  it("applies authoritative cloud truth only after a successful response", async () => {
    const repo = repository();
    const resolvedConflict = {
      ...conflict("cloud"),
      status: "resolved" as const,
      resolution: "fork-local" as const,
      conflictVersion: 2,
    };
    const outcome = {
      status: "resolved",
      response: {
        result: {
          idempotencyKey: "33333333-3333-4333-8333-333333333333",
          kind: "save",
          status: "applied",
          code: null,
          slotId: "main-fork",
          localRevision: 2,
          serverRevision: 1,
          conflictId: resolvedConflict.id,
          resolvedBranch: {
            slotId: "main-fork",
            deleted: false,
            serverRevision: 1,
            clientRevision: 2,
            gameVersion: "1.0.0",
            saveSchemaVersion: 1,
            checksum: "a".repeat(64),
            seed: null,
          },
        },
        conflict: resolvedConflict,
        saves: [],
      },
    } as unknown as Extract<VectorConflictResolutionOutcome, { status: "resolved" }>;
    const resolveCloud = vi.fn(async () => outcome);

    await expect(executeVectorConflictResolution({
      repository: repo,
      ownerKey: OWNER,
      conflict: conflict("cloud"),
      resolution: "fork-local",
      targetSlotId: "main-fork",
      idempotencyKey: "33333333-3333-4333-8333-333333333333",
      resolveCloud,
    })).resolves.toBe(outcome);

    expect(resolveCloud).toHaveBeenCalledWith(expect.objectContaining({
      conflictId: "22222222-2222-4222-8222-222222222222",
      idempotencyKey: "33333333-3333-4333-8333-333333333333",
      resolution: {
        expectedConflictVersion: 1,
        resolution: "fork-local",
        targetSlotId: "main-fork",
      },
    }));
    expect(repo.applyCloudConflictResolution).toHaveBeenCalledWith(
      OWNER,
      resolvedConflict,
      [],
      {
        resolution: "fork-local",
        targetSlotId: "main-fork",
        resolvedBranch: outcome.response.result.resolvedBranch,
      },
    );
  });

  it("does not mutate local state after a cloud error or owner transition", async () => {
    const repo = repository();
    const resolveCloud = vi.fn(async () => ({
      status: "error" as const,
      code: "VECTOR_CONFLICT_NETWORK",
      retryable: true,
    }));

    await expect(executeVectorConflictResolution({
      repository: repo,
      ownerKey: OWNER,
      conflict: conflict("cloud"),
      resolution: "accept-server",
      idempotencyKey: "33333333-3333-4333-8333-333333333333",
      resolveCloud,
    })).resolves.toMatchObject({ status: "error", code: "VECTOR_CONFLICT_NETWORK" });
    expect(repo.applyCloudConflictResolution).not.toHaveBeenCalled();

    const changed = repository("user:44444444-4444-4444-8444-444444444444");
    await expect(executeVectorConflictResolution({
      repository: changed,
      ownerKey: OWNER,
      conflict: conflict("local"),
      resolution: "accept-server",
      idempotencyKey: "33333333-3333-4333-8333-333333333333",
    })).resolves.toMatchObject({ status: "error", code: "VECTOR_OWNER_CHANGED" });
    expect(changed.resolveLocalConflict).not.toHaveBeenCalled();
  });

  it("rejects cloud truth that is not bound to the requested conflict intent", async () => {
    const repo = repository();
    const requested = conflict("cloud");
    const resolveCloud = vi.fn(async () => ({
      status: "resolved" as const,
      response: {
        result: {
          idempotencyKey: "33333333-3333-4333-8333-333333333333",
          kind: "save" as const,
          status: "applied" as const,
          code: null,
          slotId: "unexpected-slot",
          localRevision: 2,
          serverRevision: 2,
          conflictId: requested.id,
        },
        conflict: {
          ...requested,
          status: "resolved" as const,
          resolution: "accept-local" as const,
          conflictVersion: 2,
        },
        saves: [],
      },
    }));

    await expect(executeVectorConflictResolution({
      repository: repo,
      ownerKey: OWNER,
      conflict: requested,
      resolution: "accept-server",
      idempotencyKey: "33333333-3333-4333-8333-333333333333",
      resolveCloud,
    })).resolves.toEqual({
      status: "error",
      code: "VECTOR_CONFLICT_RESPONSE_MISMATCH",
      retryable: true,
    });
    expect(repo.applyCloudConflictResolution).not.toHaveBeenCalled();
  });
});
