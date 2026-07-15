/**
 * Resumable durable-execution core (program §15.5). When a run pauses (for an
 * approval) or fails partway, re-invoking it must NOT recompute the steps that
 * already succeeded — it must skip them and reuse their recorded output
 * snapshots. This module is the pure decision layer for that: given a routine's
 * ordered step keys and the run's existing step records, it says which steps
 * still need to run and which outputs to reuse.
 *
 * Pure and dependency-free, so the resume/idempotency logic is unit-tested and
 * the executor (which does the I/O) stays a thin wrapper.
 */

import type { StepStatus } from "./runState";

export type ExistingStep = {
  step_key: string;
  status: StepStatus;
  output_snapshot?: unknown;
};

export type ResumePlan = {
  /** Step keys still to run, in the routine's declared order. */
  toRun: string[];
  /** step_key -> output_snapshot for steps already succeeded (safe to reuse). */
  reuse: Record<string, unknown>;
};

/**
 * Plan a (re)run. A step whose key has a **succeeded** record is skipped and its
 * output reused (idempotent replay). Steps that previously failed/were skipped
 * or never ran are scheduled again, preserving declared order. A step key with
 * multiple records is treated as succeeded if any record succeeded (a retry that
 * eventually passed).
 */
export function planResume(orderedKeys: readonly string[], existing: readonly ExistingStep[]): ResumePlan {
  const succeeded = new Map<string, unknown>();
  for (const s of existing) {
    if (s.status === "succeeded" && !succeeded.has(s.step_key)) {
      succeeded.set(s.step_key, s.output_snapshot ?? null);
    }
  }
  const toRun = orderedKeys.filter((k) => !succeeded.has(k));
  const reuse: Record<string, unknown> = {};
  for (const [k, v] of succeeded) {
    if (orderedKeys.includes(k)) reuse[k] = v;
  }
  return { toRun, reuse };
}

/** Whether a specific step should be skipped as already done (idempotency). */
export function isStepAlreadyDone(stepKey: string, existing: readonly ExistingStep[]): boolean {
  return existing.some((s) => s.step_key === stepKey && s.status === "succeeded");
}

/** True when every ordered step already succeeded — nothing left to do. */
export function isRunComplete(orderedKeys: readonly string[], existing: readonly ExistingStep[]): boolean {
  return orderedKeys.length > 0 && orderedKeys.every((k) => isStepAlreadyDone(k, existing));
}
