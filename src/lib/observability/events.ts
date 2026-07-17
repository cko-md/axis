import { randomUUID } from "node:crypto";
import { z } from "zod";

/**
 * Closed structured-event catalogue for the operate loop.
 *
 * Callers cannot add event names or fields ad hoc. Every emitted value is
 * parsed by a strict schema whose strings are limited to UUIDs and fixed enums;
 * free-form text, financial values, provider payloads, and PII have no place in
 * this contract. Invalid events fail closed and emit only a fixed rejection
 * record with no caller-supplied data.
 */

const SENSITIVE_KEY = /(pass(word)?|secret|token|authorization|auth|cookie|api[_-]?key|access[_-]?key|private[_-]?key|ssn|account[_-]?number|routing[_-]?number|card[_-]?number|cvv|email|phone)/i;
const MAX_EVENT_COUNT = 1_000_000;
const MAX_EVENT_DURATION_MS = 31 * 24 * 60 * 60 * 1000;

const approvalActionClassSchema = z.enum([
  "INTERNAL_WRITE",
  "EXTERNAL_COMMUNICATION",
  "FINANCIAL_EXECUTION",
  "DESTRUCTIVE_ADMIN",
]);
const approvalRequirementSchema = z.enum(["approval", "approval_step_up"]);
const uuidSchema = z.string().uuid();
const countSchema = z.number().int().nonnegative().max(MAX_EVENT_COUNT);
const durationSchema = z.number().int().nonnegative().max(MAX_EVENT_DURATION_MS).nullable();

export const ROUTINE_EVENT_ERROR_CODES = [
  "APPROVAL_EXPIRED",
  "APPROVAL_NOT_ACTIONABLE",
  "APPROVAL_NOT_APPROVED",
  "APPROVAL_REQUIRED",
  "APPROVAL_STEP_UP_STALE",
  "CANNOT_RESUME",
  "FINANCIAL_PROFILE_UNAVAILABLE",
  "HOLDINGS_UNAVAILABLE",
  "INVALID_HOLDING",
  "MARKET_DATA_INCOMPLETE",
  "MARKET_DATA_REQUIRED",
  "PAUSED_STEP_NOT_FOUND",
  "ROUTINE_RESUME_FAILED",
  "RUN_ALREADY_TERMINAL",
  "RUN_BLOCKED",
  "RUN_BLOCK_PERSISTENCE_FAILED",
  "RUN_COMPLETE_FAILED",
  "RUN_COMPLETE_RECONCILIATION_FAILED",
  "RUN_COMPLETION_FAILED",
  "RUN_FAIL_RECORD_FAILED",
  "RUN_NOT_WAITING_FOR_APPROVAL",
  "RUN_PAUSE_FAILED",
  "RUN_PAUSE_METADATA_MISSING",
  "RUN_RELEASE_FAILED",
  "RUN_REPLAY_INCOMPLETE",
  "RUN_RESUME_CLAIM_LOST",
  "RUN_RESUME_FAILED",
  "RUN_RESUME_INVALID_COMPLETION",
  "RUN_RESUME_RENEW_FAILED",
  "RUN_RESUME_SERVICE_UNAVAILABLE",
  "RUN_START_FAILED",
  "RUN_STEP_CONFLICT",
  "RUN_STEP_NOT_FOUND",
  "RUN_STEPS_INCOMPLETE",
  "RUN_STEPS_UNAVAILABLE",
  "STEP_COMPLETE_FAILED",
  "STEP_FAIL_RECORD_FAILED",
  "STEP_PERSISTENCE_FAILED",
  "STEP_START_FAILED",
  "TASKS_UNAVAILABLE",
  "TASK_CREATE_FAILED",
  "TASK_IDEMPOTENCY_CONFLICT",
  "UNEXPECTED_ROUTINE_FAILURE",
] as const;

const REBALANCE_EVENT_STAGES = [
  "run",
  "load_holdings",
  "load_prices",
  "propose_rebalance",
  "explain_proposal",
  "persist_step",
  "complete_run",
  "persist_blocked_run",
] as const;

export const ROUTINE_EVENT_STAGES = [
  "execute",
  "resume",
  ...REBALANCE_EVENT_STAGES,
] as const;

const routineErrorCodeSchema = z.enum(ROUTINE_EVENT_ERROR_CODES);

function approvalPolicyMatches(value: {
  actionClass: z.infer<typeof approvalActionClassSchema>;
  requirement: z.infer<typeof approvalRequirementSchema>;
}): boolean {
  const needsStepUp =
    value.actionClass === "FINANCIAL_EXECUTION"
    || value.actionClass === "DESTRUCTIVE_ADMIN";
  return needsStepUp
    ? value.requirement === "approval_step_up"
    : value.requirement === "approval";
}

const eventSchemas = {
  "approval.decided": z.object({
    requestId: uuidSchema,
    approvalId: uuidSchema,
    decision: z.enum(["approved", "denied"]),
    actionClass: approvalActionClassSchema,
    requirement: approvalRequirementSchema,
    decisionLatencyMs: durationSchema,
  }).strict().superRefine((value, ctx) => {
    if (!approvalPolicyMatches(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requirement"],
        message: "approval requirement must match the action class",
      });
    }
  }),
  "approval.executed": z.object({
    requestId: uuidSchema,
    approvalId: uuidSchema,
    actionClass: approvalActionClassSchema,
    requirement: approvalRequirementSchema,
    stepUpRequired: z.boolean(),
    executeLatencyMs: durationSchema,
  }).strict().superRefine((value, ctx) => {
    if (!approvalPolicyMatches(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requirement"],
        message: "approval requirement must match the action class",
      });
    }
    if (value.stepUpRequired !== (value.requirement === "approval_step_up")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["stepUpRequired"],
        message: "step-up flag must match the approval requirement",
      });
    }
  }),
  "approval.step_up_verified": z.object({
    requestId: uuidSchema,
    approvalId: uuidSchema,
  }).strict(),
  "routine.run.completed": z.discriminatedUnion("routine", [
    z.object({
      requestId: uuidSchema,
      routine: z.literal("concentration_review"),
      runId: uuidSchema,
      status: z.literal("completed"),
      breaches: countSchema,
      tasksCreated: countSchema,
      tasksSkipped: countSchema,
      resumedFromApproval: z.boolean(),
    }).strict(),
    z.object({
      requestId: uuidSchema,
      routine: z.literal("rebalance_proposal"),
      runId: uuidSchema,
      status: z.literal("completed"),
      proposals: countSchema,
      simulationOnly: z.literal(true),
      submissionEnabled: z.literal(false),
      executionStatus: z.literal("not_submitted"),
    }).strict(),
  ]),
  "routine.run.blocked": z.discriminatedUnion("routine", [
    z.object({
      requestId: uuidSchema,
      routine: z.literal("concentration_review"),
      runId: uuidSchema.optional(),
      errorCode: routineErrorCodeSchema,
      stage: z.enum(["execute", "resume"]),
      resumedFromApproval: z.boolean(),
    }).strict(),
    z.object({
      requestId: uuidSchema,
      routine: z.literal("rebalance_proposal"),
      runId: uuidSchema,
      errorCode: routineErrorCodeSchema,
      stage: z.enum(REBALANCE_EVENT_STAGES),
      resumedFromApproval: z.literal(false),
    }).strict(),
  ]),
} as const;

export type ServerEventName = keyof typeof eventSchemas;
export type ServerEventPayload<Name extends ServerEventName> = z.input<(typeof eventSchemas)[Name]>;
export type ApprovalEventActionClass = z.infer<typeof approvalActionClassSchema>;
export type ApprovalEventRequirement = z.infer<typeof approvalRequirementSchema>;
export type RoutineEventErrorCode = (typeof ROUTINE_EVENT_ERROR_CODES)[number];
export type RoutineEventStage = (typeof ROUTINE_EVENT_STAGES)[number];
type RebalanceEventStage = (typeof REBALANCE_EVENT_STAGES)[number];

export type StructuredEvent<Name extends ServerEventName = ServerEventName> = {
  event: Name;
  eventId: string;
  schemaVersion: 1;
  ts: string;
} & ServerEventPayload<Name>;

class EventContractError extends Error {
  constructor(readonly reason: "unknown_event" | "invalid_payload") {
    super(reason);
    this.name = "EventContractError";
  }
}

/** Recursively mask sensitive-looking keys in a plain object/array. */
export function redactSafe(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth-limit]";
  if (Array.isArray(value)) return value.map((v) => redactSafe(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : redactSafe(nested, depth + 1);
    }
    return out;
  }
  return value;
}

/** Create an opaque server-generated request correlation id. */
export function createObservabilityRequestId(): string {
  return randomUUID();
}

/** Return a safe bounded duration, or null for invalid/clock-skewed input. */
export function eventDurationMs(startedAt: string | null | undefined, endedAtMs: number): number | null {
  if (!startedAt || !Number.isFinite(endedAtMs)) return null;
  const startedAtMs = Date.parse(startedAt);
  if (!Number.isFinite(startedAtMs) || endedAtMs < startedAtMs) return null;
  const duration = Math.floor(endedAtMs - startedAtMs);
  return duration <= MAX_EVENT_DURATION_MS ? duration : null;
}

/** Narrow persisted approval policy to the only combinations valid for events. */
export function approvalEventPolicy(
  actionClass: unknown,
  requirement: unknown,
): {
  actionClass: ApprovalEventActionClass;
  requirement: ApprovalEventRequirement;
} | null {
  const parsedActionClass = approvalActionClassSchema.safeParse(actionClass);
  const parsedRequirement = approvalRequirementSchema.safeParse(requirement);
  if (!parsedActionClass.success || !parsedRequirement.success) return null;
  const policy = {
    actionClass: parsedActionClass.data,
    requirement: parsedRequirement.data,
  };
  return approvalPolicyMatches(policy) ? policy : null;
}

/** Map an arbitrary caught error to the fixed, non-content-bearing code list. */
export function routineEventErrorCode(value: unknown): RoutineEventErrorCode {
  const candidate = value instanceof Error ? value.message : value;
  return typeof candidate === "string"
    && (ROUTINE_EVENT_ERROR_CODES as readonly string[]).includes(candidate)
    ? candidate as RoutineEventErrorCode
    : "UNEXPECTED_ROUTINE_FAILURE";
}

/** Map a dynamic executor operation to the fixed routine stage list. */
export function routineEventStage(value: unknown): RebalanceEventStage {
  return typeof value === "string"
    && (REBALANCE_EVENT_STAGES as readonly string[]).includes(value)
    ? value as RebalanceEventStage
    : "run";
}

/** Build a schema-validated structured event. Throws before logging on failure. */
export function structuredEvent<Name extends ServerEventName>(
  event: Name,
  fields: ServerEventPayload<Name>,
  now: Date = new Date(),
): StructuredEvent<Name> {
  const schema = (eventSchemas as Record<string, z.ZodType>)[event];
  if (!schema) throw new EventContractError("unknown_event");
  const parsed = schema.safeParse(fields);
  if (!parsed.success) throw new EventContractError("invalid_payload");
  return {
    event,
    eventId: randomUUID(),
    schemaVersion: 1,
    ts: now.toISOString(),
    ...parsed.data,
  } as StructuredEvent<Name>;
}

/**
 * Emit one validated JSON event to the server log. Contract failures never
 * throw into product behavior and never echo the rejected name or payload.
 */
export function emitServerEvent<Name extends ServerEventName>(
  event: Name,
  fields: ServerEventPayload<Name>,
): boolean {
  try {
    console.log(JSON.stringify(structuredEvent(event, fields)));
    return true;
  } catch (error) {
    const reason = error instanceof EventContractError ? error.reason : "invalid_payload";
    console.warn(JSON.stringify({
      event: "observability.event.rejected",
      eventId: randomUUID(),
      schemaVersion: 1,
      ts: new Date().toISOString(),
      reason,
    }));
    return false;
  }
}
