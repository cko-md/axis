import { describe, expect, it } from "vitest";
import type {
  VectorLocalConflict,
  VectorLocalOutboxEvent,
  VectorLocalProfile,
  VectorLocalSave,
} from "@/lib/vector/persistence-types";
import {
  buildVectorPersistenceSummaries,
  canResumeVectorSave,
  selectVectorHydratableSave,
  vectorRuntimeSettingsFromProfile,
} from "@/lib/vector/view-model";

const OWNER = "user:11111111-1111-4111-8111-111111111111" as const;
const NOW = "2026-07-16T12:00:00.000Z";

function save(syncState: VectorLocalSave["syncState"]): VectorLocalSave {
  return {
    id: `${OWNER}|second-sense|main`,
    ownerKey: OWNER,
    gameId: "second-sense",
    slotId: "main",
    gameVersion: "1.0.0",
    saveSchemaVersion: 1,
    localRevision: 2,
    serverRevision: 1,
    pendingIdempotencyKey: "11111111-1111-4111-8111-111111111112",
    deviceId: "device-12345678",
    checksum: "a".repeat(64),
    seed: null,
    state: { round: 2 },
    updatedAt: NOW,
    syncState,
    lastErrorCode: null,
  };
}

describe("VECTOR view model", () => {
  it("accepts only supported persisted runtime settings", () => {
    const profile = {
      settings: {
        motionPreference: "reduced",
        muted: true,
        volume: 4,
        lowPower: true,
      },
    } as unknown as VectorLocalProfile;
    expect(vectorRuntimeSettingsFromProfile(profile)).toMatchObject({
      motionPreference: "reduced",
      muted: true,
      volume: 1,
      lowPower: true,
    });
    expect(vectorRuntimeSettingsFromProfile({
      ...profile,
      settings: { motionPreference: "future", volume: "loud" },
    })).toMatchObject({
      motionPreference: "system",
      volume: 0.7,
    });
  });

  it("emits summaries only for real records and prioritizes conflicts", () => {
    const event = {
      id: "11111111-1111-4111-8111-111111111113",
      ownerKey: OWNER,
      gameId: "second-sense",
      status: "pending",
      createdAt: NOW,
      updatedAt: NOW,
    } as unknown as VectorLocalOutboxEvent;
    const conflict = {
      id: "11111111-1111-4111-8111-111111111114",
      ownerKey: OWNER,
      gameId: "second-sense",
      slotId: "main",
      status: "open",
    } as unknown as VectorLocalConflict;
    const summaries = buildVectorPersistenceSummaries({
      ownerScope: "account",
      saves: [save("pending")],
      outbox: [event],
      conflicts: [conflict],
      installs: [],
    });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      gameId: "second-sense",
      conflictCount: 1,
      preferredConflictSlotId: "main",
      pendingEventCount: 1,
      syncState: "conflict",
      saves: [{ conflictCount: 1, canResume: false }],
      install: { state: "not-installed" },
    });
  });

  it("labels anonymous pending records local-only without inventing cloud state", () => {
    const summaries = buildVectorPersistenceSummaries({
      ownerScope: "anonymous",
      saves: [save("local-only")],
      outbox: [],
      conflicts: [],
      installs: [],
    });
    expect(summaries[0].syncState).toBe("local-only");
  });

  it("chooses the newest save deterministically regardless of repository input order", () => {
    const older = {
      ...save("synced"),
      id: `${OWNER}|second-sense|older`,
      slotId: "older",
      updatedAt: "2026-07-16T11:00:00.000Z",
    };
    const newer = {
      ...save("synced"),
      id: `${OWNER}|second-sense|newer`,
      slotId: "newer",
      updatedAt: "2026-07-16T13:00:00.000Z",
    };
    const summaries = buildVectorPersistenceSummaries({
      ownerScope: "account",
      saves: [older, newer],
      outbox: [],
      conflicts: [],
      installs: [],
    });

    expect(summaries[0].preferredSlotId).toBe("newer");
    expect(summaries[0].saves.map((item) => item.slotId)).toEqual(["newer", "older"]);
  });

  it("surfaces an actionable conflict even when no save is safe to hydrate", () => {
    const conflict = {
      id: "11111111-1111-4111-8111-111111111115",
      ownerKey: OWNER,
      authority: "local",
      gameId: "second-sense",
      slotId: "quarantined",
      status: "open",
      reason: "local_checksum_mismatch",
      createdAt: NOW,
    } as unknown as VectorLocalConflict;
    const deterministicFirst = {
      ...conflict,
      id: "00000000-0000-4000-8000-000000000001",
      slotId: "deterministic-first",
    } as VectorLocalConflict;
    const summaries = buildVectorPersistenceSummaries({
      ownerScope: "account",
      saves: [],
      outbox: [],
      conflicts: [conflict, deterministicFirst],
      installs: [],
    });

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      gameId: "second-sense",
      saves: [],
      conflictCount: 2,
      preferredConflictSlotId: "deterministic-first",
      syncState: "conflict",
    });
  });

  it("never resumes or hydrates either branch while any game conflict is open", () => {
    const clean = save("pending");
    const openConflict = {
      id: "11111111-1111-4111-8111-111111111116",
      ownerKey: OWNER,
      authority: "cloud",
      gameId: "second-sense",
      slotId: "main",
      status: "open",
      createdAt: NOW,
    } as unknown as VectorLocalConflict;

    expect(canResumeVectorSave({
      gameAvailable: true,
      syncState: "pending",
      conflictCount: 0,
    })).toBe(true);
    expect(canResumeVectorSave({
      gameAvailable: true,
      syncState: "pending",
      conflictCount: 1,
    })).toBe(false);
    expect(selectVectorHydratableSave({
      gameId: "second-sense",
      preferredSlotId: "main",
      saves: [clean],
      conflicts: [openConflict],
    })).toBeNull();
    expect(selectVectorHydratableSave({
      gameId: "second-sense",
      preferredSlotId: "main",
      saves: [{ ...clean, syncState: "conflict" }],
      conflicts: [],
    })).toBeNull();
    expect(selectVectorHydratableSave({
      gameId: "second-sense",
      preferredSlotId: "main",
      saves: [clean],
      conflicts: [],
    })).toBe(clean);
  });
});
