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

/** Classes that reach outside the system or move money/state irreversibly. */
const OUTBOUND_OR_EXECUTION: ReadonlySet<ActionClass> = new Set([
  "EXTERNAL_COMMUNICATION",
  "FINANCIAL_EXECUTION",
  "DESTRUCTIVE_ADMIN",
]);

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
export function validateApprovalCompleteness(req: ApprovalRequest): ApprovalCompleteness {
  const missing: string[] = [];

  if (!req.actor?.id) missing.push("actor");
  if (!req.tool) missing.push("tool");
  if (!isNonEmpty(req.summary)) missing.push("summary");
  if (!req.target?.entityType) missing.push("target");

  if (OUTBOUND_OR_EXECUTION.has(req.actionClass)) {
    if (!req.dataFreshness) missing.push("dataFreshness");
    if (!isNonEmpty(req.expiresAt)) missing.push("expiresAt");
  }

  if (req.actionClass === "FINANCIAL_EXECUTION") {
    if (!isValidAmount(req.amount)) missing.push("amount");
    if (!req.target?.accountId) missing.push("target.accountId");
    if (req.beforeState === undefined) missing.push("beforeState");
    if (req.afterState === undefined) missing.push("afterState");
  }

  if (req.actionClass === "DESTRUCTIVE_ADMIN" && req.beforeState === undefined) {
    missing.push("beforeState");
  }

  return { complete: missing.length === 0, missing };
}

/**
 * Whether an approval has expired at `nowMs`. An approval with no `expiresAt`
 * never expires by time (callers may still require one via completeness). An
 * unparseable `expiresAt` is treated as expired — fail safe, never fail open.
 */
export function isApprovalExpired(req: ApprovalRequest, nowMs: number = Date.now()): boolean {
  if (!req.expiresAt) return false;
  const expiry = Date.parse(req.expiresAt);
  if (Number.isNaN(expiry)) return true;
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
  if (!validateApprovalCompleteness(req).complete) return false;
  if (isApprovalExpired(req, now)) return false;
  if (req.stepUpRequired && !isStepUpFresh(opts.stepUpVerifiedAt, opts.stepUpMaxAgeMs ?? STEP_UP_MAX_AGE_MS, now)) {
    return false;
  }
  return true;
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidAmount(amount: ApprovalAmount | undefined): boolean {
  return (
    !!amount &&
    typeof amount.value === "number" &&
    Number.isFinite(amount.value) &&
    isNonEmpty(amount.currency)
  );
}
