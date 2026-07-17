/**
 * Need-to-Know severity tiers for signals.
 *
 * Adapts Town's Need-to-Know queue (docs/axis-redesign/02-product-synthesis.md):
 * signals are triaged into a small set of tiers so the home surface can show
 * what genuinely needs attention and demote routine noise. This is a *derived*
 * display tier computed over the already-persisted `signal_type` plus context —
 * it deliberately requires no schema change. Dedup and resolution memory build
 * on the normalized key below.
 *
 * Pure and dependency-free so the derivation is identical in the scan job, the
 * API, and the UI, and is unit-testable.
 */

/** Ordered most- to least-urgent. */
export type SignalSeverity = "critical" | "actionable" | "informational" | "noise";

/** Sort weight: lower sorts first (most urgent at the top of the queue). */
export const SEVERITY_ORDER: Readonly<Record<SignalSeverity, number>> = {
  critical: 0,
  actionable: 1,
  informational: 2,
  noise: 3,
};

/** Persisted signal_type values (see src/lib/signals/scan.ts). */
type SignalTypeLike = "action" | "awaiting" | "fyi" | string | null | undefined;

const URGENT_PRIORITIES = new Set(["urgent", "critical", "high", "hi", "p0", "p1"]);

export type SeverityInput = {
  /** The persisted signal_type. */
  signalType?: SignalTypeLike;
  /** Priority of a linked task, if any (string label or numeric rank). */
  priority?: string | number | null;
  /** True when this signal duplicates one already resolved/dismissed. */
  isRedundant?: boolean;
};

/**
 * Derive the Need-to-Know severity for a signal.
 *
 * Rules (deterministic, precedence top-down):
 * 1. Redundant/expected duplicates are `noise`.
 * 2. An urgent linked priority escalates to `critical`.
 * 3. `action`/`awaiting` signals are `actionable`.
 * 4. Everything else (`fyi` and unknowns) is `informational`.
 */
export function deriveSeverity(input: SeverityInput): SignalSeverity {
  if (input.isRedundant) return "noise";

  if (isUrgentPriority(input.priority)) return "critical";

  const type = typeof input.signalType === "string" ? input.signalType.toLowerCase() : "";
  if (type === "action" || type === "awaiting") return "actionable";

  return "informational";
}

function isUrgentPriority(priority: string | number | null | undefined): boolean {
  if (priority == null) return false;
  if (typeof priority === "number") return priority <= 1; // 0/1 == P0/P1
  return URGENT_PRIORITIES.has(priority.trim().toLowerCase());
}

/**
 * Normalize a signal title into a dedup key: lowercased, punctuation stripped,
 * whitespace collapsed. Makes "Coffee Shop!", "coffee  shop" and "coffee-shop"
 * collapse to the same key, which exact-lowercase matching (the previous
 * approach in scan.ts) misses.
 */
export function normalizeSignalKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when `title` duplicates any of `existingTitles` under the normalized key. */
export function isDuplicateSignal(title: string, existingTitles: Iterable<string>): boolean {
  const key = normalizeSignalKey(title);
  if (key === "") return false;
  for (const existing of existingTitles) {
    if (normalizeSignalKey(existing) === key) return true;
  }
  return false;
}

/** Derive queue severity while remembering titles the user already resolved. */
export function deriveQueueSeverity(
  input: SeverityInput & { title: string },
  resolvedTitles: Iterable<string>,
): SignalSeverity {
  return deriveSeverity({
    ...input,
    isRedundant: Boolean(input.isRedundant) || isDuplicateSignal(input.title, resolvedTitles),
  });
}

/** Stable comparator that orders a signal list by severity (most urgent first). */
export function bySeverity(a: SignalSeverity, b: SignalSeverity): number {
  return SEVERITY_ORDER[a] - SEVERITY_ORDER[b];
}
