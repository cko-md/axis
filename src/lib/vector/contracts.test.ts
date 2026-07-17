import { describe, expect, it } from "vitest";
import {
  VECTOR_JSON_MAX_DEPTH,
  VECTOR_JSON_MAX_NODES,
  VECTOR_PROFILE_MAX_DOCUMENT_BYTES,
  vectorBootstrapQuerySchema,
  vectorBootstrapResponseSchema,
  vectorConflictResolutionSchema,
  vectorJsonSchema,
  vectorSyncEventSchema,
  vectorSyncRequestSchema,
  vectorSyncResponseSchema,
} from "@/lib/vector/contracts";
import { vectorJsonBytes } from "@/lib/vector/checksum";

const save = {
  idempotencyKey: "11111111-1111-4111-8111-111111111111",
  slotId: "campaign-1",
  gameVersion: "1.0.0",
  saveSchemaVersion: 1,
  expectedServerRevision: 0,
  localRevision: 1,
  checksum: "a".repeat(64),
  seed: "daily-1",
  state: { level: 1 },
  updatedAt: "2026-07-16T18:00:00.000Z",
};

describe("VECTOR sync contracts", () => {
  it("requires state-bearing bootstrap requests to be scoped to one game", () => {
    expect(vectorBootstrapQuerySchema.safeParse({ includeState: "1" }).success).toBe(false);
    expect(vectorBootstrapQuerySchema.safeParse({
      includeState: "1",
      gameId: "second-sense",
    }).success).toBe(true);
    expect(vectorBootstrapQuerySchema.safeParse({ includeState: "0" }).success).toBe(true);
  });

  it("rejects cloud profile documents above the shared 16 KiB contract", () => {
    const counters: Record<string, number> = {};
    for (let index = 0; index < 1_750; index += 1) counters[`p${index}`] = 0;
    counters.overflow = 1;
    expect(vectorJsonBytes(counters)).toBeGreaterThan(VECTOR_PROFILE_MAX_DOCUMENT_BYTES);
    expect(vectorBootstrapResponseSchema.safeParse({
      profile: {
        settings: {},
        settingClocks: {},
        unlocks: [],
        counters,
        serverRevision: 1,
        updatedAt: "2026-07-16T18:00:00.000Z",
      },
      saves: [],
      scores: [],
      achievements: [],
      conflicts: [],
      truncated: { saves: false, scores: false, achievements: false, conflicts: false },
      serverTime: "2026-07-16T18:00:00.000Z",
    }).success).toBe(false);
  });

  it("accepts a strict, bounded save batch", () => {
    expect(vectorSyncRequestSchema.safeParse({
      gameId: "second-sense",
      deviceId: "device-12345678",
      saves: [save],
      events: [],
    }).success).toBe(true);
  });

  it("rejects unknown games, extra fields, and empty sync requests", () => {
    expect(vectorSyncRequestSchema.safeParse({
      gameId: "fake-game",
      deviceId: "device-12345678",
      saves: [save],
      events: [],
    }).success).toBe(false);
    expect(vectorSyncRequestSchema.safeParse({
      gameId: "second-sense",
      deviceId: "device-12345678",
      saves: [],
      events: [],
    }).success).toBe(false);
    expect(vectorSyncRequestSchema.safeParse({
      gameId: "second-sense",
      deviceId: "device-12345678",
      saves: [save],
      events: [],
      userId: "client-controlled-owner",
    }).success).toBe(false);
  });

  it("requires matching clocks for every settings field", () => {
    const base = {
      idempotencyKey: "22222222-2222-4222-8222-222222222222",
      localRevision: 1,
      occurredAt: "2026-07-16T18:00:00.000Z",
      kind: "settings",
    };
    expect(vectorSyncEventSchema.safeParse({
      ...base,
      payload: {
        values: { muted: true },
        clocks: {
          muted: { at: "2026-07-16T18:00:00.000Z", deviceId: "device-12345678" },
        },
      },
    }).success).toBe(true);
    expect(vectorSyncEventSchema.safeParse({
      ...base,
      payload: { values: { muted: true }, clocks: {} },
    }).success).toBe(false);
    expect(vectorSyncEventSchema.safeParse({
      ...base,
      payload: {
        values: { muted: true },
        clocks: {
          muted: { at: "2026-07-16T18:00:00.0001Z", deviceId: "device-12345678" },
        },
      },
    }).success).toBe(false);
  });

  it("requires a target slot only for fork resolution", () => {
    const base = {
      idempotencyKey: "33333333-3333-4333-8333-333333333333",
      expectedConflictVersion: 1,
    };
    expect(vectorConflictResolutionSchema.safeParse({
      ...base,
      resolution: "fork-local",
      targetSlotId: "fork-1",
    }).success).toBe(true);
    expect(vectorConflictResolutionSchema.safeParse({
      ...base,
      resolution: "fork-local",
    }).success).toBe(false);
    expect(vectorConflictResolutionSchema.safeParse({
      ...base,
      resolution: "accept-server",
      targetSlotId: "fork-1",
    }).success).toBe(false);
  });

  it("rejects over-deep JSON without recursive stack failure", () => {
    let atLimit: unknown = null;
    for (let depth = 0; depth < VECTOR_JSON_MAX_DEPTH; depth += 1) {
      atLimit = [atLimit];
    }
    expect(vectorJsonSchema.safeParse(atLimit).success).toBe(true);

    const overLimit = [atLimit];
    expect(() => vectorJsonSchema.safeParse(overLimit)).not.toThrow();
    expect(vectorJsonSchema.safeParse(overLimit).success).toBe(false);
  });

  it("bounds JSON node count and rejects non-JSON object graphs", () => {
    expect(vectorJsonSchema.safeParse(
      Array.from({ length: VECTOR_JSON_MAX_NODES - 1 }, () => null),
    ).success).toBe(true);
    expect(vectorJsonSchema.safeParse(
      Array.from({ length: VECTOR_JSON_MAX_NODES }, () => null),
    ).success).toBe(false);
    expect(vectorJsonSchema.safeParse(Number.POSITIVE_INFINITY).success).toBe(false);
    expect(vectorJsonSchema.safeParse(new Date()).success).toBe(false);

    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    expect(() => vectorJsonSchema.safeParse(cyclic)).not.toThrow();
    expect(vectorJsonSchema.safeParse(cyclic).success).toBe(false);
  });

  it("defaults truncation truth for backward-compatible response fixtures", () => {
    const serverTime = "2026-07-16T18:00:00.000Z";
    const bootstrap = vectorBootstrapResponseSchema.parse({
      profile: null,
      saves: [],
      scores: [],
      achievements: [],
      conflicts: [],
      serverTime,
    });
    expect(bootstrap.truncated).toEqual({
      saves: false,
      scores: false,
      achievements: false,
      conflicts: false,
    });

    const sync = vectorSyncResponseSchema.parse({
      partial: false,
      results: [],
      saves: [],
      conflicts: [],
      serverTime,
    });
    expect(sync.truncated).toEqual({ saves: false, conflicts: false });
  });

  it("accepts a maximum-length counter ID after game namespacing", () => {
    const key = `phantasy-axis:${"c".repeat(64)}`;
    expect(vectorBootstrapResponseSchema.safeParse({
      profile: {
        settings: {},
        settingClocks: {},
        unlocks: [],
        counters: { [key]: 1 },
        serverRevision: 1,
        updatedAt: "2026-07-16T18:00:00.000Z",
      },
      saves: [],
      scores: [],
      achievements: [],
      conflicts: [],
      serverTime: "2026-07-16T18:00:00.000Z",
    }).success).toBe(true);
  });
});
