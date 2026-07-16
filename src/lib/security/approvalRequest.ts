/**
 * The approval object — the durable, inspectable record of a gated action
 * (program security model §11.3; backs supabase/migrations/…_approvals_table).
 *
 * `actionPolicy.ts` answers *whether* an action needs approval. This module
 * answers *what a complete approval looks like*: it turns a proposed action plus
 * its context into a fully-scoped `ApprovalRequest`, and enforces the rule that
 * an approval is **never a bare "Allow" button** — the user (or a UI, or the
 * approvals table) must always be shown the exact action, target, amount,
 * before/after state, data freshness, and expiry before granting it.
 *
 * Pure and dependency-free (composes `decideApproval` and reuses the freshness
 * shape from the Fund provenance layer) so the same request is constructed and
 * validated identically in the agent runtime, the API, and the UI, and the
 * completeness rules are unit-testable rather than living in prose.
 */

import type { FreshnessTier } from "../fund/provenance";
import {
  decideApproval,
  type ActionClass,
  type ActionContext,
  type ApprovalRequirement,
} from "./actionPolicy";

/** Who or what proposed the action. */
export type ApprovalActor = {
  kind: "user" | "agent" | "routine";
  /** Stable id of the actor (user id, agent id, routine id). */
  id: string;
  /** For routines: the exact version proposing the action (§11.3 auditability). */
  routineVersion?: number;
};

/** The concrete thing an action operates on. */
export type ApprovalTarget = {
  /** Canonical entity type, e.g. "account", "holding", "email", "integration". */
  entityType: string;
  /** The affected entity id, if one exists yet. */
  entityId?: string;
  /** The financial account involved, for execution/communication actions. */
  accountId?: string;
};

/** Money/quantity an action would move. Amounts are major units (see money.ts). */
export type ApprovalAmount = {
  value: number;
  /** ISO-4217 currency code. */
  currency: string;
  /** Share/contract quantity for trades, if applicable. */
  quantity?: number;
};

/** How fresh the data the decision rests on is (data timestamp, §11.3). */
export type ApprovalDataFreshness = {
  tier: FreshnessTier;
  /** ISO-8601 timestamp the underlying data was retrieved. */
  retrievedAt: string;
};

/** One-time consent vs. a standing, routine-scoped permission. */
export type ApprovalScope = "one_time" | "persistent";

/** Everything needed to build (and validate) an approval object. */
export type ApprovalRequestInput = {
  actor: ApprovalActor;
  /** The exact tool that would run (e.g. "public.place_order", "gmail.send"). */
  tool: string;
  /** Human-readable exact action — what will happen, in one line. */
  summary: string;
  /** Action class + risk flags; feeds the policy decision. */
  context: ActionContext;
  target: ApprovalTarget;
  amount?: ApprovalAmount;
  /** State before the action, for reversible-diff review. */
  beforeState?: unknown;
  /** Proposed state after the action. */
  afterState?: unknown;
  dataFreshness?: ApprovalDataFreshness;
  /** Defaults to one_time; persistent is never allowed for execution/destructive. */
  scope?: ApprovalScope;
  /** ISO-8601 expiry; a stale approval must not be actionable (§11.3). */
  expiresAt?: string;
  /** Link back to the task this approval belongs to, if any. */
  taskId?: string;
};

/** The complete, inspectable approval object. */
export type ApprovalRequest = ApprovalRequestInput & {
  actionClass: ActionClass;
  requirement: ApprovalRequirement;
  /** Why approval is required, most significant first (from decideApproval). */
  reasons: string[];
  /** Whether step-up authentication is required before this may be acted on. */
  stepUpRequired: boolean;
  scope: ApprovalScope;
};

/** Result of checking an approval object for "never a bare Allow" completeness. */
export type ApprovalCompleteness = {
  complete: boolean;
  /** Missing required fields, by name; empty when complete. */
  missing: string[];
};

export const APPROVAL_MAX_LIFETIME_MS = 24 * 60 * 60_000;
export const APPROVAL_CLOCK_SKEW_MS = 60_000;
/** Execution requires provider data no older than the market-price stale SLA. */
export const FINANCIAL_DATA_MAX_AGE_MS = 15 * 60_000;

const ACTOR_ID_MAX = 512;
const TOOL_MAX = 256;
const SUMMARY_MAX = 2_000;
const TARGET_TYPE_MAX = 128;
const TARGET_ID_MAX = 512;
const MAX_ROUTINE_VERSION = 2_147_483_647;
const ACTOR_KINDS = ["user", "agent", "routine"] as const;
const FRESHNESS_TIERS: readonly FreshnessTier[] = ["fresh", "delayed", "stale", "unknown"];
const ACTION_CLASSES: readonly ActionClass[] = [
  "READ",
  "DRAFT",
  "SIMULATE",
  "INTERNAL_WRITE",
  "EXTERNAL_COMMUNICATION",
  "FINANCIAL_EXECUTION",
  "DESTRUCTIVE_ADMIN",
];
const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Classes that reach outside the system or move money/state irreversibly. */
const OUTBOUND_OR_EXECUTION: ReadonlySet<ActionClass> = new Set([
  "EXTERNAL_COMMUNICATION",
  "FINANCIAL_EXECUTION",
  "DESTRUCTIVE_ADMIN",
]);

export type ApprovalRequestParseResult =
  | { ok: true; value: ApprovalRequestInput }
  | { ok: false; code: "INVALID_BODY" | "INVALID_ACTION_CLASS" };

/**
 * Parse the untrusted API payload without asserting it into a trusted type.
 * Unknown fields are discarded; malformed values are rejected before policy
 * evaluation or persistence.
 */
export function parseApprovalRequestInput(
  input: unknown,
  nowMs: number = Date.now(),
): ApprovalRequestParseResult {
  if (!isRecord(input) || !isRecord(input.actor) || !isRecord(input.context) || !isRecord(input.target)) {
    return { ok: false, code: "INVALID_BODY" };
  }

  const actionClass = input.context.actionClass;
  if (!isActionClass(actionClass)) {
    return { ok: false, code: "INVALID_ACTION_CLASS" };
  }

  const actorKind = input.actor.kind;
  const actorId = input.actor.id;
  if (
    !isActorKind(actorKind)
    || !isBoundedText(actorId, ACTOR_ID_MAX)
  ) {
    return { ok: false, code: "INVALID_BODY" };
  }
  const routineVersion = input.actor.routineVersion;
  if (
    (actorKind === "routine" && !isValidRoutineVersion(routineVersion))
    || (actorKind !== "routine" && routineVersion !== undefined)
  ) {
    return { ok: false, code: "INVALID_BODY" };
  }

  if (
    !isBoundedText(input.tool, TOOL_MAX)
    || !isBoundedText(input.summary, SUMMARY_MAX)
    || !isBoundedText(input.target.entityType, TARGET_TYPE_MAX)
    || !isOptionalBoundedText(input.target.entityId, TARGET_ID_MAX)
    || !isOptionalBoundedText(input.target.accountId, TARGET_ID_MAX)
  ) {
    return { ok: false, code: "INVALID_BODY" };
  }

  const touchesSensitiveData = input.context.touchesSensitiveData;
  const usesUntrustedExternalContent = input.context.usesUntrustedExternalContent;
  const explicitlyTrusted = input.context.explicitlyTrusted;
  if (
    !isOptionalBoolean(touchesSensitiveData)
    || !isOptionalBoolean(usesUntrustedExternalContent)
    || !isOptionalBoolean(explicitlyTrusted)
  ) {
    return { ok: false, code: "INVALID_BODY" };
  }

  const amount = parseAmount(input.amount);
  if (!amount.ok) return { ok: false, code: "INVALID_BODY" };

  const dataFreshness = parseDataFreshness(input.dataFreshness, actionClass, nowMs);
  if (!dataFreshness.ok) return { ok: false, code: "INVALID_BODY" };

  if (
    (input.beforeState !== undefined && !isJsonObject(input.beforeState))
    || (input.afterState !== undefined && !isJsonObject(input.afterState))
  ) {
    return { ok: false, code: "INVALID_BODY" };
  }

  const scope = input.scope;
  if (scope !== undefined && scope !== "one_time" && scope !== "persistent") {
    return { ok: false, code: "INVALID_BODY" };
  }

  const expiresAt = input.expiresAt;
  if (expiresAt !== undefined && !isValidApprovalExpiry(expiresAt, nowMs)) {
    return { ok: false, code: "INVALID_BODY" };
  }
  const taskId = input.taskId;
  if (taskId !== undefined && (typeof taskId !== "string" || !UUID.test(taskId))) {
    return { ok: false, code: "INVALID_BODY" };
  }

  return {
    ok: true,
    value: {
      actor: {
        kind: actorKind,
        id: actorId.trim(),
        ...(actorKind === "routine" ? { routineVersion: Number(routineVersion) } : {}),
      },
      tool: input.tool.trim(),
      summary: input.summary.trim(),
      context: {
        actionClass,
        ...(touchesSensitiveData !== undefined ? { touchesSensitiveData } : {}),
        ...(usesUntrustedExternalContent !== undefined ? { usesUntrustedExternalContent } : {}),
        ...(explicitlyTrusted !== undefined ? { explicitlyTrusted } : {}),
      },
      target: {
        entityType: input.target.entityType.trim(),
        ...(typeof input.target.entityId === "string" ? { entityId: input.target.entityId.trim() } : {}),
        ...(typeof input.target.accountId === "string" ? { accountId: input.target.accountId.trim() } : {}),
      },
      ...(amount.value ? { amount: amount.value } : {}),
      ...(input.beforeState !== undefined ? { beforeState: input.beforeState } : {}),
      ...(input.afterState !== undefined ? { afterState: input.afterState } : {}),
      ...(dataFreshness.value ? { dataFreshness: dataFreshness.value } : {}),
      ...(scope !== undefined ? { scope } : {}),
      ...(typeof expiresAt === "string" ? { expiresAt } : {}),
      ...(typeof taskId === "string" ? { taskId } : {}),
    },
  };
}

/**
 * Build a fully-scoped approval object from a proposed action. Derives the
 * requirement, reasons, and step-up flag from `decideApproval`, so the object
 * can never disagree with the policy kernel.
 *
 * `persistent` scope is silently downgraded to `one_time` for financial
 * execution and destructive admin — a standing "always allow" permission must
 * never exist for those classes (§7 program prompt: no persistent session-wide
 * financial allow).
 */
export function buildApprovalRequest(input: ApprovalRequestInput): ApprovalRequest {
  const decision = decideApproval(input.context);
  const actionClass = input.context.actionClass;

  let scope: ApprovalScope = input.scope ?? "one_time";
  if (
    scope === "persistent" &&
    (actionClass === "FINANCIAL_EXECUTION" || actionClass === "DESTRUCTIVE_ADMIN")
  ) {
    scope = "one_time";
  }

  return {
    ...input,
    actionClass,
    requirement: decision.requirement,
    reasons: decision.reasons,
    stepUpRequired: decision.requirement === "approval_step_up",
    scope,
  };
}

/**
 * Validate that an approval object shows the full scope of what it authorizes —
 * the guard behind "never provide a vague Allow button without the complete
 * scope" (§11.3). Every approval must name an actor, tool, summary, and target.
 * Higher-risk classes must additionally carry the details a human needs to judge
 * the action:
 *
 * - outbound/executing actions must state data freshness and an expiry;
 * - financial execution must state amount + currency, the account, and
 *   before/after state;
 * - destructive admin must state before-state (what is being destroyed).
 */
export function validateApprovalCompleteness(
  req: ApprovalRequest,
  nowMs: number = Date.now(),
): ApprovalCompleteness {
  const missing: string[] = [];
  const addMissing = (field: string) => {
    if (!missing.includes(field)) missing.push(field);
  };

  if (
    !isActionClass(req.actionClass)
    || req.context?.actionClass !== req.actionClass
    || !isValidPersistedPolicy(req)
  ) {
    addMissing("policy");
  }
  if (
    !Array.isArray(req.reasons)
    || req.reasons.length === 0
    || req.reasons.some((reason) => !isBoundedText(reason, SUMMARY_MAX))
  ) {
    addMissing("reasons");
  }
  if (req.scope !== "one_time" && req.scope !== "persistent") addMissing("scope");

  if (
    !req.actor
    || !ACTOR_KINDS.includes(req.actor.kind)
    || !isBoundedText(req.actor.id, ACTOR_ID_MAX)
    || (req.actor.kind === "routine" && !isValidRoutineVersion(req.actor.routineVersion))
    || (req.actor.kind !== "routine" && req.actor.routineVersion !== undefined)
  ) {
    addMissing("actor");
  }
  if (!isBoundedText(req.tool, TOOL_MAX)) addMissing("tool");
  if (!isBoundedText(req.summary, SUMMARY_MAX)) addMissing("summary");
  if (
    !req.target
    || !isBoundedText(req.target.entityType, TARGET_TYPE_MAX)
    || !isOptionalBoundedText(req.target.entityId, TARGET_ID_MAX)
    || !isOptionalBoundedText(req.target.accountId, TARGET_ID_MAX)
  ) {
    addMissing("target");
  }
  if (
    !isOptionalBoolean(req.context?.touchesSensitiveData)
    || !isOptionalBoolean(req.context?.usesUntrustedExternalContent)
    || !isOptionalBoolean(req.context?.explicitlyTrusted)
  ) {
    addMissing("context");
  }
  if (req.amount !== undefined && !isValidAmount(req.amount)) addMissing("amount");
  if (req.beforeState !== undefined && !isJsonObject(req.beforeState)) addMissing("beforeState");
  if (req.afterState !== undefined && !isJsonObject(req.afterState)) addMissing("afterState");
  if (
    req.dataFreshness !== undefined
    && !isValidDataFreshness(req.dataFreshness, req.actionClass, nowMs)
  ) {
    addMissing("dataFreshness");
  }
  if (req.expiresAt !== undefined && !isValidApprovalExpiry(req.expiresAt, nowMs)) {
    addMissing("expiresAt");
  }

  if (OUTBOUND_OR_EXECUTION.has(req.actionClass)) {
    if (!isValidDataFreshness(req.dataFreshness, req.actionClass, nowMs)) addMissing("dataFreshness");
    if (!isValidApprovalExpiry(req.expiresAt, nowMs)) addMissing("expiresAt");
  }

  if (req.actionClass === "FINANCIAL_EXECUTION") {
    if (req.scope !== "one_time") addMissing("scope");
    if (!isValidAmount(req.amount)) addMissing("amount");
    if (!isBoundedText(req.target?.accountId, TARGET_ID_MAX)) addMissing("target.accountId");
    if (!isJsonObject(req.beforeState)) addMissing("beforeState");
    if (!isJsonObject(req.afterState)) addMissing("afterState");
  }

  if (req.actionClass === "DESTRUCTIVE_ADMIN" && !isJsonObject(req.beforeState)) {
    addMissing("beforeState");
  }
  if (req.actionClass === "DESTRUCTIVE_ADMIN" && req.scope !== "one_time") addMissing("scope");

  return { complete: missing.length === 0, missing };
}

/**
 * Whether an approval has expired at `nowMs`. An approval with no `expiresAt`
 * never expires by time (callers may still require one via completeness). An
 * unparseable `expiresAt` is treated as expired — fail safe, never fail open.
 */
export function isApprovalExpired(req: ApprovalRequest, nowMs: number = Date.now()): boolean {
  if (!req.expiresAt) return false;
  const expiry = parseIsoInstant(req.expiresAt);
  if (expiry === null) return true;
  return nowMs >= expiry;
}

/**
 * How long a step-up (WebAuthn) verification stays valid before it must be
 * re-done. A step-up proves identity *at a moment*; a long-lived approval must
 * not be executable on identity proof from hours ago (§11.2 defense-in-depth).
 */
export const STEP_UP_MAX_AGE_MS = 5 * 60_000;

/**
 * Whether a step-up verification is present and recent enough to act on. Missing,
 * unparseable, clearly-future (beyond clock skew), or older than `maxAgeMs` all
 * return false — fail safe.
 */
export function isStepUpFresh(
  verifiedAt: string | null | undefined,
  maxAgeMs: number = STEP_UP_MAX_AGE_MS,
  nowMs: number = Date.now(),
): boolean {
  if (!verifiedAt) return false;
  const t = Date.parse(verifiedAt);
  if (!Number.isFinite(t)) return false;
  const age = nowMs - t;
  if (age < -60_000) return false; // future-dated beyond skew
  return age <= maxAgeMs;
}

/**
 * Whether an approval object is safe to act on right now: it must be complete,
 * not expired, and — for step-up classes — have a **fresh** step-up verification
 * (`stepUpVerifiedAt` within the max age). This is the single gate execution
 * paths should consult before proceeding.
 */
export function isActionable(
  req: ApprovalRequest,
  opts: { stepUpVerifiedAt?: string | null; nowMs?: number; stepUpMaxAgeMs?: number } = {},
): boolean {
  const now = opts.nowMs ?? Date.now();
  if (!validateApprovalCompleteness(req, now).complete) return false;
  if (isApprovalExpired(req, now)) return false;
  if (req.stepUpRequired && !isStepUpFresh(opts.stepUpVerifiedAt, opts.stepUpMaxAgeMs ?? STEP_UP_MAX_AGE_MS, now)) {
    return false;
  }
  return true;
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return isRecord(value);
}

function isBoundedText(value: unknown, max: number): value is string {
  return isNonEmpty(value) && value.length <= max;
}

function isOptionalBoundedText(value: unknown, max: number): boolean {
  return value === undefined || isBoundedText(value, max);
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean";
}

function isValidRoutineVersion(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0 && Number(value) <= MAX_ROUTINE_VERSION;
}

function parseAmount(
  value: unknown,
): { ok: true; value?: ApprovalAmount } | { ok: false } {
  if (value === undefined) return { ok: true };
  if (!isRecord(value)) return { ok: false };
  if (
    typeof value.value !== "number"
    || typeof value.currency !== "string"
    || (value.quantity !== undefined && typeof value.quantity !== "number")
  ) {
    return { ok: false };
  }
  const amount: ApprovalAmount = {
    value: value.value,
    currency: value.currency,
    ...(value.quantity !== undefined ? { quantity: value.quantity } : {}),
  };
  return isValidAmount(amount) ? { ok: true, value: amount } : { ok: false };
}

function isValidAmount(amount: ApprovalAmount | undefined): boolean {
  return (
    !!amount &&
    typeof amount.value === "number" &&
    Number.isFinite(amount.value) &&
    amount.value > 0 &&
    typeof amount.currency === "string" &&
    /^[A-Z]{3}$/.test(amount.currency) &&
    (
      amount.quantity === undefined
      || (
        typeof amount.quantity === "number"
        && Number.isFinite(amount.quantity)
        && amount.quantity > 0
      )
    )
  );
}

function parseDataFreshness(
  value: unknown,
  actionClass: ActionClass,
  nowMs: number,
): { ok: true; value?: ApprovalDataFreshness } | { ok: false } {
  if (value === undefined) return { ok: true };
  if (!isRecord(value)) return { ok: false };
  if (
    !isFreshnessTier(value.tier)
    || typeof value.retrievedAt !== "string"
    || parseIsoInstant(value.retrievedAt) === null
  ) {
    return { ok: false };
  }
  const parsed = {
    tier: value.tier,
    retrievedAt: value.retrievedAt,
  };
  if (!isValidDataFreshness(parsed, actionClass, nowMs)) {
    return { ok: false };
  }
  return {
    ok: true,
    value: parsed,
  };
}

function isValidDataFreshness(
  value: ApprovalDataFreshness | undefined,
  actionClass: ActionClass,
  nowMs: number,
): boolean {
  if (!value || !FRESHNESS_TIERS.includes(value.tier)) {
    return false;
  }
  const retrievedAt = parseIsoInstant(value.retrievedAt);
  if (retrievedAt === null || retrievedAt > nowMs + APPROVAL_CLOCK_SKEW_MS) return false;
  if (actionClass !== "FINANCIAL_EXECUTION") return true;
  return (
    (value.tier === "fresh" || value.tier === "delayed")
    && retrievedAt >= nowMs - FINANCIAL_DATA_MAX_AGE_MS
  );
}

function isActorKind(value: unknown): value is ApprovalActor["kind"] {
  return typeof value === "string" && ACTOR_KINDS.some((kind) => kind === value);
}

function isActionClass(value: unknown): value is ActionClass {
  return typeof value === "string" && ACTION_CLASSES.some((actionClass) => actionClass === value);
}

function isFreshnessTier(value: unknown): value is FreshnessTier {
  return typeof value === "string" && FRESHNESS_TIERS.some((tier) => tier === value);
}

function isValidPersistedPolicy(req: ApprovalRequest): boolean {
  return (
    (
      (req.actionClass === "INTERNAL_WRITE" || req.actionClass === "EXTERNAL_COMMUNICATION")
      && req.requirement === "approval"
      && req.stepUpRequired === false
    )
    || (
      (req.actionClass === "FINANCIAL_EXECUTION" || req.actionClass === "DESTRUCTIVE_ADMIN")
      && req.requirement === "approval_step_up"
      && req.stepUpRequired === true
    )
  );
}

function isValidApprovalExpiry(value: unknown, nowMs: number): value is string {
  if (typeof value !== "string") return false;
  const expiry = parseIsoInstant(value);
  return expiry !== null && expiry > nowMs && expiry <= nowMs + APPROVAL_MAX_LIFETIME_MS;
}

function parseIsoInstant(value: string): number | null {
  const match = ISO_INSTANT.exec(value);
  if (!match) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  const date = new Date(parsed);
  if (
    date.getUTCFullYear() !== Number(match[1])
    || date.getUTCMonth() + 1 !== Number(match[2])
    || date.getUTCDate() !== Number(match[3])
    || date.getUTCHours() !== Number(match[4])
    || date.getUTCMinutes() !== Number(match[5])
    || date.getUTCSeconds() !== Number(match[6])
  ) {
    return null;
  }
  return parsed;
}
