/**
 * Provenance, freshness, and reconciliation for financial values.
 *
 * The safety kernel (see docs/axis-redesign/04-target-architecture.md and
 * 05 financial-domain notes) requires that every financially material value be
 * able to expose *where it came from* and *how fresh it is*, and that we never
 * present delayed provider data as real-time. This module is the deterministic,
 * dependency-free domain layer for that — pure functions with no I/O, so the
 * rules are unit-testable and reused identically by server jobs and UI badges.
 *
 * It intentionally does not touch the database. Persisting provenance columns is
 * a separate, migration-gated wave; this defines the typed shape and the pure
 * classification logic those columns will feed.
 */

import { toMinorUnits } from "./money";

/** Reconciliation status of a value against a second source of truth. */
export type ReconciliationState =
  | "matched" // both sources present and equal within tolerance
  | "partial" // exactly one source present
  | "conflicting" // both present but disagree beyond tolerance
  | "missing" // neither source present
  | "stale" // present but older than its freshness SLA
  | "pending"; // awaiting reconciliation

/** Where a financial value came from and when it was true. */
export type Provenance = {
  /** Source system, e.g. "plaid", "public", "manual", "polygon". */
  provider: string;
  /** The provider's own record id, for idempotency and audit trails. */
  providerRecordId?: string;
  /** ISO-8601 timestamp the value was retrieved from the provider. */
  retrievedAt: string;
  /** ISO-8601 timestamp the value was effective (as-of), if distinct. */
  effectiveAt?: string;
  /** ISO-4217 currency code the amount is denominated in. */
  currency: string;
  /** Optional 0..1 confidence for classified/inferred values. */
  confidence?: number;
  /** Optional reconciliation status against a second source. */
  reconciliation?: ReconciliationState;
};

/**
 * Freshness tier derived from a value's age against its SLA. Kept small and
 * age-derivable; connection-level states (offline / revalidating / conflicting)
 * are tracked separately by the caller and are not a pure function of age.
 */
export type FreshnessTier = "fresh" | "delayed" | "stale" | "unknown";

/** Age thresholds for a data class, in milliseconds. */
export type FreshnessSla = {
  /** At or below this age the value is fresh. */
  freshWithinMs: number;
  /** Above `freshWithinMs` and at or below this, the value is delayed. */
  staleAfterMs: number;
};

/**
 * Sensible default SLAs per data class. Callers should pass an explicit SLA
 * where the data class matters; these are starting points, not policy.
 */
export const FRESHNESS_SLAS = {
  /** Delayed market quotes: minutes matter. */
  marketPrice: { freshWithinMs: 60_000, staleAfterMs: 15 * 60_000 },
  /** Bank/brokerage balances synced periodically: hours. */
  accountBalance: { freshWithinMs: 6 * 3_600_000, staleAfterMs: 24 * 3_600_000 },
  /** Positions/holdings: a day. */
  holdings: { freshWithinMs: 12 * 3_600_000, staleAfterMs: 48 * 3_600_000 },
} as const satisfies Record<string, FreshnessSla>;

/**
 * Classify how fresh a value is from when it was retrieved. Invalid/missing
 * timestamps and future timestamps beyond a small skew return "unknown" rather
 * than falsely reporting "fresh".
 *
 * @param retrievedAt ISO timestamp (or Date) the value was retrieved.
 * @param sla         Age thresholds for this data class.
 * @param now         Reference time (defaults to Date.now()), for testability.
 */
export function classifyFreshness(
  retrievedAt: string | Date | null | undefined,
  sla: FreshnessSla,
  now: number = Date.now(),
): FreshnessTier {
  if (retrievedAt == null) return "unknown";
  const retrievedMs = retrievedAt instanceof Date ? retrievedAt.getTime() : Date.parse(retrievedAt);
  if (!Number.isFinite(retrievedMs)) return "unknown";

  const age = now - retrievedMs;
  // Small tolerance for clock skew; a value from the future is not "fresh".
  const CLOCK_SKEW_MS = 60_000;
  if (age < -CLOCK_SKEW_MS) return "unknown";

  const effectiveAge = Math.max(age, 0);
  if (effectiveAge <= sla.freshWithinMs) return "fresh";
  if (effectiveAge <= sla.staleAfterMs) return "delayed";
  return "stale";
}

/** True when a value must not be treated as authoritative/real-time. */
export function isStale(tier: FreshnessTier): boolean {
  return tier === "stale" || tier === "unknown";
}

/**
 * Reconcile an expected amount against an observed amount from a second source.
 * Comparison is exact at the cent (via {@link toMinorUnits}); `toleranceMinor`
 * allows a symmetric allowance in minor units (cents) for known provider
 * rounding differences.
 *
 * @returns the {@link ReconciliationState} describing agreement between sources.
 */
export function reconcileAmount(
  expected: number | string | null | undefined,
  observed: number | string | null | undefined,
  toleranceMinor = 0,
): ReconciliationState {
  const hasExpected = expected != null && expected !== "";
  const hasObserved = observed != null && observed !== "";

  if (!hasExpected && !hasObserved) return "missing";
  if (!hasExpected || !hasObserved) return "partial";

  const diff = Math.abs(toMinorUnits(expected) - toMinorUnits(observed));
  return diff <= Math.abs(toleranceMinor) ? "matched" : "conflicting";
}
