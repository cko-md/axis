import { z } from "zod";
import type { Json } from "@/lib/supabase/database.types";
import { vectorJsonBytes } from "@/lib/vector/checksum";
import { VECTOR_GAME_SLUGS, type VectorGameSlug } from "@/lib/vector/types";

export const VECTOR_SYNC_MAX_BODY_BYTES = 1024 * 1024;
export const VECTOR_SAVE_MAX_STATE_BYTES = 128 * 1024;
export const VECTOR_PROFILE_MAX_DOCUMENT_BYTES = 16 * 1024;
export const VECTOR_EVENT_MAX_PAYLOAD_BYTES = 4 * 1024;
export const VECTOR_CONFLICT_BRANCH_MAX_BYTES = VECTOR_SAVE_MAX_STATE_BYTES;
export const VECTOR_SYNC_MAX_SAVES = 4;
export const VECTOR_SYNC_MAX_EVENTS = 64;
export const VECTOR_MAX_SAVE_SLOTS = 8;
export const VECTOR_JSON_MAX_DEPTH = 64;
export const VECTOR_JSON_MAX_NODES = 50_000;
export const VECTOR_BOOTSTRAP_MAX_SAVES = 72;
export const VECTOR_BOOTSTRAP_MAX_SCORES = 200;
export const VECTOR_BOOTSTRAP_MAX_ACHIEVEMENTS = 500;
export const VECTOR_BOOTSTRAP_MAX_CONFLICTS = 100;
export const VECTOR_BOOTSTRAP_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const VECTOR_SYNC_REFRESH_MAX_SAVES = VECTOR_MAX_SAVE_SLOTS;
export const VECTOR_SYNC_REFRESH_MAX_CONFLICTS = 32;

const ID = /^[a-z0-9][a-z0-9._:-]*$/i;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z._+-]*$/;
const SHA256 = /^[a-f0-9]{64}$/;

export const vectorGameIdSchema = z.enum(VECTOR_GAME_SLUGS);
export const vectorSlotIdSchema = z.string().trim().min(1).max(64).regex(ID);
export const vectorDeviceIdSchema = z.string().trim().min(8).max(128).regex(ID);
export const vectorVersionSchema = z.string().trim().min(1).max(32).regex(VERSION);
export const vectorChecksumSchema = z.string().regex(SHA256);
export const vectorIdempotencyKeySchema = z.string().uuid();

type VectorJsonFrame =
  | { phase: "visit"; value: unknown; depth: number }
  | { phase: "leave"; value: object };

/**
 * Validate untrusted JSON iteratively so an adversarial nesting depth cannot
 * overflow the JavaScript call stack before request-size checks run.
 */
function isBoundedVectorJson(input: unknown): input is Json {
  const stack: VectorJsonFrame[] = [{ phase: "visit", value: input, depth: 0 }];
  const ancestors = new WeakSet<object>();
  let nodeCount = 0;

  try {
    while (stack.length > 0) {
      const frame = stack.pop();
      if (!frame) break;
      if (frame.phase === "leave") {
        ancestors.delete(frame.value);
        continue;
      }

      nodeCount += 1;
      if (nodeCount > VECTOR_JSON_MAX_NODES) return false;

      const value = frame.value;
      if (value === null || typeof value === "string" || typeof value === "boolean") {
        continue;
      }
      if (typeof value === "number") {
        if (!Number.isFinite(value)) return false;
        continue;
      }
      if (typeof value !== "object") return false;
      if (ancestors.has(value)) return false;

      if (Array.isArray(value)) {
        if (value.length > VECTOR_JSON_MAX_NODES - nodeCount) return false;
        if (value.length > 0 && frame.depth >= VECTOR_JSON_MAX_DEPTH) return false;
        ancestors.add(value);
        stack.push({ phase: "leave", value });
        for (let index = value.length - 1; index >= 0; index -= 1) {
          stack.push({ phase: "visit", value: value[index], depth: frame.depth + 1 });
        }
        continue;
      }

      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return false;
      const keys = Object.keys(value);
      if (keys.length > VECTOR_JSON_MAX_NODES - nodeCount) return false;
      if (keys.length > 0 && frame.depth >= VECTOR_JSON_MAX_DEPTH) return false;
      if (Object.getOwnPropertySymbols(value).some((symbol) =>
        Object.prototype.propertyIsEnumerable.call(value, symbol))) {
        return false;
      }

      ancestors.add(value);
      stack.push({ phase: "leave", value });
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, keys[index]);
        if (!descriptor || !("value" in descriptor)) return false;
        stack.push({ phase: "visit", value: descriptor.value, depth: frame.depth + 1 });
      }
    }
  } catch {
    return false;
  }

  return true;
}

export const vectorJsonSchema: z.ZodType<Json> = z.custom<Json>(isBoundedVectorJson, {
  message: `Expected bounded JSON (depth <= ${VECTOR_JSON_MAX_DEPTH}, nodes <= ${VECTOR_JSON_MAX_NODES}).`,
});

export const vectorSavePushSchema = z.object({
  idempotencyKey: vectorIdempotencyKeySchema,
  slotId: vectorSlotIdSchema,
  gameVersion: vectorVersionSchema,
  saveSchemaVersion: z.number().int().positive().max(10_000),
  expectedServerRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  localRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  checksum: vectorChecksumSchema,
  seed: z.string().max(256).nullable(),
  state: vectorJsonSchema,
  updatedAt: z.string().datetime({ offset: true }),
}).strict();

export const vectorLocalSaveInputSchema = z.object({
  gameId: vectorGameIdSchema,
  slotId: vectorSlotIdSchema,
  gameVersion: vectorVersionSchema,
  saveSchemaVersion: z.number().int().positive().max(10_000),
  deviceId: vectorDeviceIdSchema,
  seed: z.string().max(256).nullable(),
  state: vectorJsonSchema,
  checkpointLabel: z.string().trim().min(1).max(128).optional(),
  updatedAt: z.string().datetime({ offset: true }).optional(),
}).strict();

const eventBaseSchema = z.object({
  idempotencyKey: vectorIdempotencyKeySchema,
  localRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  occurredAt: z.string().datetime({ offset: true }),
});

const scoreEventSchema = eventBaseSchema.extend({
  kind: z.literal("score"),
  payload: z.object({
    mode: z.string().trim().min(1).max(64).regex(ID),
    challengeId: z.string().trim().min(1).max(64).regex(ID).nullable(),
    value: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }).strict(),
}).strict();

const achievementEventSchema = eventBaseSchema.extend({
  kind: z.literal("achievement"),
  payload: z.object({
    achievementId: z.string().trim().min(1).max(96).regex(ID),
  }).strict(),
}).strict();

const counterEventSchema = eventBaseSchema.extend({
  kind: z.literal("counter"),
  payload: z.object({
    counterId: z.string().trim().min(1).max(64).regex(ID),
    delta: z.number().int().positive().max(1_000_000),
  }).strict(),
}).strict();

const vectorSettingClockTimestampSchema = z.string()
  .datetime({ offset: true })
  .refine((value) => {
    const match = value.match(/(?:\.(\d+))?(?:Z|[+-]\d{2}:\d{2})$/i);
    return Boolean(match) && (!match?.[1] || match[1].length <= 3);
  }, "Setting clocks must use millisecond precision");

export const vectorSettingClockSchema = z.object({
  at: vectorSettingClockTimestampSchema,
  deviceId: vectorDeviceIdSchema,
}).strict();

const settingsEventSchema = eventBaseSchema.extend({
  kind: z.literal("settings"),
  payload: z.object({
    values: z.record(z.string().min(1).max(64).regex(ID), vectorJsonSchema),
    clocks: z.record(z.string().min(1).max(64).regex(ID), vectorSettingClockSchema),
  }).strict().superRefine((value, context) => {
    const valueKeys = Object.keys(value.values);
    const clockKeys = Object.keys(value.clocks);
    if (valueKeys.length > 32) {
      context.addIssue({ code: "custom", message: "Too many setting fields." });
    }
    if (
      valueKeys.length !== clockKeys.length ||
      valueKeys.some((key) => !Object.prototype.hasOwnProperty.call(value.clocks, key))
    ) {
      context.addIssue({ code: "custom", message: "Every setting requires a matching clock." });
    }
  }),
}).strict();

export const vectorSyncEventSchema = z.discriminatedUnion("kind", [
  scoreEventSchema,
  achievementEventSchema,
  counterEventSchema,
  settingsEventSchema,
]);

export const vectorSyncRequestSchema = z.object({
  gameId: vectorGameIdSchema,
  deviceId: vectorDeviceIdSchema,
  saves: z.array(vectorSavePushSchema).max(VECTOR_SYNC_MAX_SAVES),
  events: z.array(vectorSyncEventSchema).max(VECTOR_SYNC_MAX_EVENTS),
}).strict().refine((value) => value.saves.length + value.events.length > 0, {
  message: "At least one save or event is required.",
});

export const vectorBootstrapQuerySchema = z.object({
  gameId: vectorGameIdSchema.optional(),
  includeState: z.enum(["0", "1"]).default("0"),
}).strict().superRefine((value, context) => {
  if (value.includeState === "1" && value.gameId === undefined) {
    context.addIssue({
      code: "custom",
      path: ["gameId"],
      message: "State-bearing bootstrap requests must be scoped to one game.",
    });
  }
});

export const vectorConflictResolutionSchema = z.object({
  idempotencyKey: vectorIdempotencyKeySchema,
  expectedConflictVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  resolution: z.enum(["accept-local", "accept-server", "fork-local"]),
  targetSlotId: vectorSlotIdSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.resolution === "fork-local" && !value.targetSlotId) {
    context.addIssue({
      code: "custom",
      path: ["targetSlotId"],
      message: "A target slot is required when forking.",
    });
  }
  if (value.resolution !== "fork-local" && value.targetSlotId !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["targetSlotId"],
      message: "Target slot is only valid when forking.",
    });
  }
});

export const vectorCloudSaveSchema = z.object({
  gameId: vectorGameIdSchema,
  slotId: vectorSlotIdSchema,
  gameVersion: vectorVersionSchema,
  saveSchemaVersion: z.number().int().positive(),
  serverRevision: z.number().int().positive(),
  clientRevision: z.number().int().positive(),
  deviceId: vectorDeviceIdSchema,
  checksum: vectorChecksumSchema,
  seed: z.string().max(256).nullable(),
  state: vectorJsonSchema.optional(),
  updatedAt: z.string().datetime({ offset: true }),
  deletedAt: z.string().datetime({ offset: true }).nullable(),
}).strict();

export const vectorCloudConflictSchema = z.object({
  id: z.string().uuid(),
  gameId: vectorGameIdSchema,
  slotId: vectorSlotIdSchema,
  reason: z.string().min(1).max(64),
  conflictVersion: z.number().int().positive(),
  status: z.enum(["open", "resolved"]),
  local: z.object({
    localRevision: z.number().int().positive(),
    gameVersion: vectorVersionSchema,
    saveSchemaVersion: z.number().int().positive(),
    checksum: vectorChecksumSchema,
    seed: z.string().max(256).nullable(),
    state: vectorJsonSchema.optional(),
    updatedAt: z.string().datetime({ offset: true }),
  }).strict(),
  server: z.object({
    serverRevision: z.number().int().nonnegative(),
    gameVersion: vectorVersionSchema.nullable(),
    saveSchemaVersion: z.number().int().positive().nullable(),
    checksum: vectorChecksumSchema.nullable(),
    seed: z.string().max(256).nullable(),
    state: vectorJsonSchema.optional(),
    updatedAt: z.string().datetime({ offset: true }).nullable(),
  }).strict(),
  resolution: z.enum(["accept-local", "accept-server", "fork-local"]).nullable(),
  createdAt: z.string().datetime({ offset: true }),
  resolvedAt: z.string().datetime({ offset: true }).nullable(),
}).strict();

export const vectorCloudProfileSchema = z.object({
  settings: z.record(z.string(), vectorJsonSchema),
  settingClocks: z.record(z.string(), vectorSettingClockSchema),
  unlocks: z.array(z.string().min(1).max(96).regex(ID)).max(256),
  counters: z.record(
    z.string().min(1).max(96).regex(ID),
    z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  ),
  serverRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  updatedAt: z.string().datetime({ offset: true }),
}).strict().superRefine((value, context) => {
  const documents = [
    ["settings", value.settings as Json],
    ["settingClocks", value.settingClocks as unknown as Json],
    ["counters", value.counters as unknown as Json],
  ] as const;
  for (const [path, document] of documents) {
    if (vectorJsonBytes(document) > VECTOR_PROFILE_MAX_DOCUMENT_BYTES) {
      context.addIssue({
        code: "custom",
        path: [path],
        message: `Profile document exceeds ${VECTOR_PROFILE_MAX_DOCUMENT_BYTES} bytes.`,
      });
    }
  }
});

export const vectorCloudScoreSchema = z.object({
  gameId: vectorGameIdSchema,
  mode: z.string().min(1).max(64).regex(ID),
  challengeId: z.string().min(1).max(64).regex(ID).nullable(),
  score: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  verificationStatus: z.enum(["unverified", "verified", "rejected"]),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();

export const vectorCloudAchievementSchema = z.object({
  gameId: vectorGameIdSchema,
  achievementId: z.string().min(1).max(96).regex(ID),
  unlockedAt: z.string().datetime({ offset: true }),
}).strict();

const vectorBootstrapTruncationSchema = z.object({
  saves: z.boolean(),
  scores: z.boolean(),
  achievements: z.boolean(),
  conflicts: z.boolean(),
}).strict();

const vectorSyncTruncationSchema = z.object({
  saves: z.boolean(),
  conflicts: z.boolean(),
}).strict();

export const vectorBootstrapResponseSchema = z.object({
  profile: vectorCloudProfileSchema.nullable(),
  saves: z.array(vectorCloudSaveSchema).max(VECTOR_BOOTSTRAP_MAX_SAVES),
  scores: z.array(vectorCloudScoreSchema).max(VECTOR_BOOTSTRAP_MAX_SCORES),
  achievements: z.array(vectorCloudAchievementSchema).max(VECTOR_BOOTSTRAP_MAX_ACHIEVEMENTS),
  conflicts: z.array(vectorCloudConflictSchema).max(VECTOR_BOOTSTRAP_MAX_CONFLICTS),
  truncated: vectorBootstrapTruncationSchema.default({
    saves: false,
    scores: false,
    achievements: false,
    conflicts: false,
  }),
  serverTime: z.string().datetime({ offset: true }),
}).strict();

export const vectorResolvedBranchSchema = z.object({
  slotId: vectorSlotIdSchema,
  deleted: z.boolean(),
  serverRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  clientRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
  gameVersion: vectorVersionSchema.nullable(),
  saveSchemaVersion: z.number().int().positive().max(10_000).nullable(),
  checksum: vectorChecksumSchema.nullable(),
  seed: z.string().max(256).nullable(),
}).strict().superRefine((value, context) => {
  const nullableBranchFields = [
    value.clientRevision,
    value.gameVersion,
    value.saveSchemaVersion,
    value.checksum,
  ];
  if (value.deleted) {
    if (
      value.serverRevision !== 0 ||
      value.seed !== null ||
      nullableBranchFields.some((field) => field !== null)
    ) {
      context.addIssue({ code: "custom", message: "Deleted branch fingerprint is invalid." });
    }
  } else if (nullableBranchFields.some((field) => field === null)) {
    context.addIssue({ code: "custom", message: "Live branch fingerprint is incomplete." });
  }
});

export const vectorSyncItemResultSchema = z.object({
  idempotencyKey: vectorIdempotencyKeySchema,
  kind: z.enum(["save", "score", "achievement", "counter", "settings"]),
  status: z.enum(["applied", "duplicate", "conflict", "rejected"]),
  code: z.string().max(80).nullable(),
  slotId: vectorSlotIdSchema.nullable(),
  localRevision: z.number().int().positive().nullable(),
  serverRevision: z.number().int().nonnegative().nullable(),
  conflictId: z.string().uuid().nullable(),
  authoritativeValue: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  resolvedBranch: vectorResolvedBranchSchema.optional(),
}).strict();

export const vectorSyncResponseSchema = z.object({
  partial: z.boolean(),
  results: z.array(vectorSyncItemResultSchema),
  saves: z.array(vectorCloudSaveSchema).max(VECTOR_SYNC_REFRESH_MAX_SAVES),
  conflicts: z.array(vectorCloudConflictSchema).max(VECTOR_SYNC_REFRESH_MAX_CONFLICTS),
  truncated: vectorSyncTruncationSchema.default({ saves: false, conflicts: false }),
  serverTime: z.string().datetime({ offset: true }),
}).strict();

export const vectorConflictResolutionResultSchema = vectorSyncItemResultSchema;

export const vectorConflictResolutionResponseSchema = z.object({
  result: vectorConflictResolutionResultSchema,
  conflict: vectorCloudConflictSchema,
  saves: z.array(vectorCloudSaveSchema).max(VECTOR_MAX_SAVE_SLOTS),
}).strict().superRefine((value, context) => {
  if (
    (value.result.status === "applied" || value.result.status === "duplicate") &&
    value.result.resolvedBranch === undefined
  ) {
    context.addIssue({
      code: "custom",
      path: ["result", "resolvedBranch"],
      message: "Successful conflict resolution must include its atomic branch fingerprint.",
    });
  }
});

export type VectorSavePush = z.infer<typeof vectorSavePushSchema>;
export type VectorSyncEvent = z.infer<typeof vectorSyncEventSchema>;
export type VectorSyncRequest = z.infer<typeof vectorSyncRequestSchema>;
export type VectorConflictResolution = z.infer<typeof vectorConflictResolutionSchema>;
export type VectorCloudSave = z.infer<typeof vectorCloudSaveSchema>;
export type VectorCloudConflict = z.infer<typeof vectorCloudConflictSchema>;
export type VectorCloudProfile = z.infer<typeof vectorCloudProfileSchema>;
export type VectorBootstrapResponse = z.infer<typeof vectorBootstrapResponseSchema>;
export type VectorSyncItemResult = z.infer<typeof vectorSyncItemResultSchema>;
export type VectorSyncResponse = z.infer<typeof vectorSyncResponseSchema>;
export type VectorResolvedBranch = z.infer<typeof vectorResolvedBranchSchema>;
export type VectorConflictResolutionResponse = z.infer<
  typeof vectorConflictResolutionResponseSchema
>;

export function isVectorGameSlug(value: string): value is VectorGameSlug {
  return (VECTOR_GAME_SLUGS as readonly string[]).includes(value);
}
