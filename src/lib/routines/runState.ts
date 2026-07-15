/**
 * Durable routine-run domain (program §15.5). A routine run persists its status
 * and each step's status, input/output snapshots, and errors so a run can be
 * inspected, resumed after an approval pause, and audited. This module is the
 * pure state machine at the core of that — the legal statuses and transitions
 * for a run and its steps — with no I/O, so the rules are unit-tested and
 * enforced identically by the executor, the API, and any UI.
 */

export type RunStatus =
  | "queued"
  | "running"
  | "waiting_for_approval"
  | "blocked"
  | "completed"
  | "partial" // some steps succeeded, some failed
  | "failed"
  | "cancelled";

export type StepStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";

export const RUN_TERMINAL: ReadonlySet<RunStatus> = new Set([
  "completed",
  "partial",
  "failed",
  "cancelled",
]);

export const STEP_TERMINAL: ReadonlySet<StepStatus> = new Set(["succeeded", "failed", "skipped"]);

const RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  queued: ["running", "cancelled"],
  running: ["waiting_for_approval", "blocked", "completed", "partial", "failed", "cancelled"],
  waiting_for_approval: ["running", "cancelled", "failed"],
  blocked: ["running", "failed", "cancelled"],
  completed: [],
  partial: [],
  failed: [],
  cancelled: [],
};

const STEP_TRANSITIONS: Readonly<Record<StepStatus, readonly StepStatus[]>> = {
  pending: ["running", "skipped"],
  running: ["succeeded", "failed"],
  succeeded: [],
  failed: [],
  skipped: [],
};

export function isRunTerminal(status: RunStatus): boolean {
  return RUN_TERMINAL.has(status);
}

export function isStepTerminal(status: StepStatus): boolean {
  return STEP_TERMINAL.has(status);
}

export function canRunTransition(from: RunStatus, to: RunStatus): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

export function canStepTransition(from: StepStatus, to: StepStatus): boolean {
  return STEP_TRANSITIONS[from].includes(to);
}

export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  if (!canRunTransition(from, to)) throw new Error(`Illegal run transition: ${from} -> ${to}`);
}

export function assertStepTransition(from: StepStatus, to: StepStatus): void {
  if (!canStepTransition(from, to)) throw new Error(`Illegal step transition: ${from} -> ${to}`);
}

/**
 * Derive a run's terminal status from its step outcomes. All succeeded/skipped
 * → completed; a mix of succeeded and failed → partial; all failed → failed; an
 * empty run → completed (nothing to do is a success, per §15.5's explicit
 * "nothing to do" handling).
 */
export function deriveRunOutcome(stepStatuses: readonly StepStatus[]): RunStatus {
  const meaningful = stepStatuses.filter((s) => s !== "skipped");
  if (meaningful.length === 0) return "completed";
  const failed = meaningful.filter((s) => s === "failed").length;
  if (failed === 0) return "completed";
  if (failed === meaningful.length) return "failed";
  return "partial";
}
