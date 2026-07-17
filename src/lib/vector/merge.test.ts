import { describe, expect, it } from "vitest";
import {
  mergeVectorBestScore,
  mergeVectorCampaignRevision,
  mergeVectorMonotonicCounters,
  mergeVectorSettings,
  mergeVectorStringSet,
  migrateVectorSave,
  prepareVectorRuntimeSave,
} from "@/lib/vector/merge";

describe("VECTOR deterministic merge rules", () => {
  it("merges scores, sets, and counters monotonically", () => {
    expect(mergeVectorBestScore(90, 80)).toBe(90);
    expect(mergeVectorBestScore(90, 120)).toBe(120);
    expect(mergeVectorStringSet(["b", "a"], ["b", "c"])).toEqual(["a", "b", "c"]);
    expect(mergeVectorMonotonicCounters({ plays: 4 }, { plays: 3, wins: 1 })).toEqual({
      plays: 4,
      wins: 1,
    });
  });

  it("merges settings per field clock with a deterministic device tie break", () => {
    expect(mergeVectorSettings({
      currentValues: { muted: false, volume: 0.5 },
      currentClocks: {
        muted: { at: "2026-07-16T10:00:00.000Z", deviceId: "device-a" },
        volume: { at: "2026-07-16T10:00:00.000Z", deviceId: "device-z" },
      },
      incomingValues: { muted: true, volume: 0.8 },
      incomingClocks: {
        muted: { at: "2026-07-16T10:01:00.000Z", deviceId: "device-a" },
        volume: { at: "2026-07-16T10:00:00.000Z", deviceId: "device-a" },
      },
    })).toEqual({
      values: { muted: true, volume: 0.5 },
      clocks: {
        muted: { at: "2026-07-16T10:01:00.000Z", deviceId: "device-a" },
        volume: { at: "2026-07-16T10:00:00.000Z", deviceId: "device-z" },
      },
    });
  });

  it("uses bytewise ASCII ordering for mixed-case device clock ties", () => {
    const at = "2026-07-16T10:00:00.000Z";

    expect(mergeVectorSettings({
      currentValues: { lowerWins: false, upperLoses: false },
      currentClocks: {
        lowerWins: { at, deviceId: "Device-zzz" },
        upperLoses: { at, deviceId: "device-aaa" },
      },
      incomingValues: { lowerWins: true, upperLoses: true },
      incomingClocks: {
        lowerWins: { at, deviceId: "device-aaa" },
        upperLoses: { at, deviceId: "Device-zzz" },
      },
    })).toEqual({
      values: { lowerWins: true, upperLoses: false },
      clocks: {
        lowerWins: { at, deviceId: "device-aaa" },
        upperLoses: { at, deviceId: "device-aaa" },
      },
    });
  });

  it("preserves sub-millisecond ordering before applying a device tie break", () => {
    expect(mergeVectorSettings({
      currentValues: { volume: 0.8 },
      currentClocks: {
        volume: { at: "2026-07-16T10:00:00.0002Z", deviceId: "device-a" },
      },
      incomingValues: { volume: 0.1 },
      incomingClocks: {
        volume: { at: "2026-07-16T10:00:00.0001Z", deviceId: "device-z" },
      },
    }).values.volume).toBe(0.8);
  });

  it("repairs an invalid stored setting clock without accepting an invalid incoming clock", () => {
    expect(mergeVectorSettings({
      currentValues: { volume: 0.1 },
      currentClocks: { volume: { at: "invalid", deviceId: "device-z" } },
      incomingValues: { volume: 0.8 },
      incomingClocks: {
        volume: { at: "2026-07-16T10:00:00.000Z", deviceId: "device-a" },
      },
    })).toEqual({
      values: { volume: 0.8 },
      clocks: {
        volume: { at: "2026-07-16T10:00:00.000Z", deviceId: "device-a" },
      },
    });

    expect(mergeVectorSettings({
      currentValues: { volume: 0.1 },
      currentClocks: {
        volume: { at: "2026-07-16T10:00:00.000Z", deviceId: "device-a" },
      },
      incomingValues: { volume: 0.8 },
      incomingClocks: { volume: { at: "invalid", deviceId: "device-z" } },
    }).values.volume).toBe(0.1);
  });

  it("requires compare-and-set for campaign saves", () => {
    const local = {
      localRevision: 3,
      serverRevision: 1,
      expectedServerRevision: 1,
      checksum: "local",
    };
    expect(mergeVectorCampaignRevision(local, {
      localRevision: 2,
      serverRevision: 1,
      expectedServerRevision: 0,
      checksum: "remote",
    })).toBe("use-local");
    expect(mergeVectorCampaignRevision(local, {
      localRevision: 2,
      serverRevision: 2,
      expectedServerRevision: 1,
      checksum: "remote",
    })).toBe("conflict");
    expect(mergeVectorCampaignRevision(local, {
      localRevision: 999,
      serverRevision: 2,
      expectedServerRevision: 1,
      checksum: "remote",
    })).toBe("conflict");
  });

  it("runs only ordered save migrators and preserves the source on failure", () => {
    const migrated = migrateVectorSave({ count: 1 }, 1, 3, [
      {
        from: 1,
        to: 2,
        migrate: (state) => ({ ...(state as Record<string, number>), count: 2 }),
      },
      {
        from: 2,
        to: 3,
        migrate: (state) => ({ ...(state as Record<string, number>), done: true }),
      },
    ]);
    expect(migrated).toEqual({
      ok: true,
      state: { count: 2, done: true },
      schemaVersion: 3,
    });
    expect(migrateVectorSave({ count: 1 }, 1, 3, [{
      from: 1,
      to: 2,
      migrate: () => {
        throw new Error("corrupt");
      },
    }])).toMatchObject({
      ok: false,
      code: "SAVE_MIGRATION_FAILED",
      original: { count: 1 },
    });
    expect(migrateVectorSave({ count: 1 }, 4, 3, [])).toMatchObject({
      ok: false,
      code: "SAVE_SCHEMA_NEWER",
      original: { count: 1 },
      schemaVersion: 4,
    });
    expect(migrateVectorSave({ count: 1 }, 1, 3, [])).toMatchObject({
      ok: false,
      code: "SAVE_MIGRATOR_MISSING",
      original: { count: 1 },
      schemaVersion: 1,
    });
    expect(migrateVectorSave({ count: 1 }, 3, 3, [])).toEqual({
      ok: true,
      state: { count: 1 },
      schemaVersion: 3,
    });
    expect(migrateVectorSave({ count: 1 }, 1, 2, [{
      from: 1,
      to: 2,
      migrate: () => ({ invalid: Number.NaN }) as never,
    }])).toMatchObject({
      ok: false,
      code: "SAVE_MIGRATION_FAILED",
      original: { count: 1 },
    });
  });

  it("prepares hydration only through explicit ordered schema migration", () => {
    const source = {
      schemaVersion: 1,
      data: { count: 1 },
      checksum: "source-checksum",
      seed: "daily-seed",
    };
    expect(prepareVectorRuntimeSave(source, 2, [{
      from: 1,
      to: 2,
      migrate: (state) => ({ ...(state as object), count: 2 }),
    }])).toEqual({
      ok: true,
      migrated: true,
      save: {
        schemaVersion: 2,
        data: { count: 2 },
        seed: "daily-seed",
      },
    });
    expect(prepareVectorRuntimeSave({ ...source, seed: "" }, 2, [{
      from: 1,
      to: 2,
      migrate: (state) => state,
    }])).toMatchObject({
      ok: true,
      save: { seed: "" },
    });
    expect(prepareVectorRuntimeSave(source, 3, [])).toEqual({
      ok: false,
      code: "SAVE_MIGRATOR_MISSING",
    });
    expect(prepareVectorRuntimeSave({ ...source, schemaVersion: 4 }, 3, []))
      .toEqual({ ok: false, code: "SAVE_SCHEMA_NEWER" });
    expect(prepareVectorRuntimeSave(source, 2, [{
      from: 1,
      to: 2,
      migrate: () => {
        throw new Error("private state must not escape");
      },
    }])).toEqual({ ok: false, code: "SAVE_MIGRATION_FAILED" });
  });
});
