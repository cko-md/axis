/**
 * The durable agent-Task lifecycle for Axis.
 *
 * Adapted from Town's shared-task model (see docs/axis-redesign/02-product-
 * synthesis.md): a Task — not a chat thread — is the canonical, resumable unit
 * of ongoing work. It carries source context, evidence, proposed actions, and
 * approvals across pauses. Chat is an *interface* to a task, never the record of
 * truth.
 *
 * This module is the deterministic core of that model: the set of statuses and
 * the legal transitions between them. Keeping the state machine pure and
 * dependency-free means every write path (agent runtime, API, UI action) can
 * guard against illegal transitions with the same rules, and the rules are
 * unit-testable. Persistence (a tasks table + RLS) is a separate migration-gated
 * wave; this defines the contract that persistence will enforce.
 */

export type FinancialTaskStatus =
  | "queued"
  | "gathering_data"
  | "researching"
  | "calculating"
  | "waiting_for_data"
  | "waiting_for_user"
  | "waiting_for_approval"
  | "executing"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export const TASK_STATUSES: readonly FinancialTaskStatus[] = [
  "queued",
  "gathering_data",
  "researching",
  "calculating",
  "waiting_for_data",
  "waiting_for_user",
  "waiting_for_approval",
  "executing",
  "blocked",
  "completed",
  "failed",
  "cancelled",
] as const;

/** Terminal statuses: a task that reaches one of these does not transition again. */
export const TERMINAL_STATUSES: ReadonlySet<FinancialTaskStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

/** Statuses in which the agent is actively doing work. */
export const ACTIVE_STATUSES: readonly FinancialTaskStatus[] = [
  "gathering_data",
  "researching",
  "calculating",
  "executing",
] as const;

/** Statuses in which the task is paused pending an external input. */
export const WAITING_STATUSES: readonly FinancialTaskStatus[] = [
  "waiting_for_data",
  "waiting_for_user",
  "waiting_for_approval",
] as const;

export function isTerminal(status: FinancialTaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function isWaiting(status: FinancialTaskStatus): boolean {
  return (WAITING_STATUSES as readonly string[]).includes(status);
}

const active = ACTIVE_STATUSES;
const waiting = WAITING_STATUSES;
const done: readonly FinancialTaskStatus[] = ["completed", "failed", "cancelled"];

/**
 * Legal next-statuses for each status. A task can always fail or be cancelled
 * from any non-terminal state; active work can pause into a waiting state and
 * resume; an approval is granted by moving to `executing` or denied by moving to
 * `blocked`/`cancelled`. Terminal states have no successors.
 */
export const TASK_TRANSITIONS: Readonly<Record<FinancialTaskStatus, readonly FinancialTaskStatus[]>> = {
  queued: [...active, "blocked", "cancelled"],
  gathering_data: ["researching", "calculating", "executing", ...waiting, "blocked", ...done],
  researching: ["gathering_data", "calculating", "executing", ...waiting, "blocked", ...done],
  calculating: ["gathering_data", "researching", "executing", ...waiting, "blocked", ...done],
  executing: ["calculating", ...waiting, "blocked", ...done],
  waiting_for_data: [...active, "blocked", "failed", "cancelled"],
  waiting_for_user: [...active, "blocked", "failed", "cancelled"],
  waiting_for_approval: ["executing", ...active, "blocked", "failed", "cancelled"],
  blocked: [...active, "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

/** Whether moving from `from` to `to` is a legal transition. */
export function canTransition(from: FinancialTaskStatus, to: FinancialTaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

/**
 * Assert a transition is legal, throwing otherwise. Use at write boundaries so
 * an illegal status change (e.g. reviving a completed task, or executing without
 * passing through approval) fails loudly instead of corrupting task history.
 */
export function assertTransition(from: FinancialTaskStatus, to: FinancialTaskStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal task transition: ${from} -> ${to}`);
  }
}
