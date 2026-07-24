/**
 * Concentration review — a deterministic Skill (program §15.2). Given a set of
 * positions it computes each position's weight and flags any that exceed a
 * target maximum. Pure, dependency-light (uses the cent-exact money helpers), and
 * unit-tested: the plan requires financial significance to be decided by typed
 * code, never free-form model reasoning. The output is evidence a routine turns
 * into a Task — it does not itself touch the DB, network, or any model.
 */

import { strictExactMinorUnits } from "@/lib/fund/financialTruth";

export type Position = {
  symbol: string;
  /** Position value in major units (the Fund uses cost_basis as the value proxy). */
  value: number;
};

export type ConcentrationBreach = {
  symbol: string;
  value: number;
  /** Weight as a fraction 0..1, rounded to 4 dp for stable display/tests. */
  weight: number;
  /** Value that would need to be trimmed to reach the target weight (major units). */
  overByValue: number;
};

export type ConcentrationReview = {
  total: number;
  /** All positions with weights, descending by weight. */
  positions: (Position & { weight: number })[];
  /** Positions above the target max weight, most concentrated first. */
  breaches: ConcentrationBreach[];
};

const DEFAULT_MAX_WEIGHT = 0.25;

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/**
 * Review positions against a maximum single-position weight.
 *
 * Weights are computed on integer minor units so the denominator is exact; a
 * zero/empty portfolio yields no breaches (never divide by zero). `maxWeight` is
 * clamped to (0, 1].
 */
export function reviewConcentration(
  positions: Position[],
  maxWeight: number = DEFAULT_MAX_WEIGHT,
): ConcentrationReview {
  const cap = Math.min(1, Math.max(0.0001, maxWeight));
  const normalized = positions.map((position) => ({
    ...position,
    valueMinor: strictExactMinorUnits(position.value, "USD"),
  }));
  if (normalized.some((position) => position.valueMinor === null || position.valueMinor! < 0)) {
    return { total: 0, positions: positions.map((p) => ({ ...p, weight: 0 })), breaches: [] };
  }
  const totalMinor = normalized.reduce((sum, position) => sum + (position.valueMinor as number), 0);
  const total = totalMinor / 100;

  if (totalMinor <= 0) {
    return { total: 0, positions: positions.map((p) => ({ ...p, weight: 0 })), breaches: [] };
  }

  const withWeights = positions
    .map((p) => {
      const minor = strictExactMinorUnits(p.value, "USD") as number;
      return { ...p, weight: round4(minor / totalMinor) };
    })
    .sort((a, b) => b.weight - a.weight);

  const breaches: ConcentrationBreach[] = withWeights
    .filter((p) => p.weight > cap)
    .map((p) => {
      const targetValue = (cap * totalMinor) / 100; // minor -> major
      const overByValue = Math.max(0, round2(p.value - targetValue));
      return { symbol: p.symbol, value: p.value, weight: p.weight, overByValue };
    });

  return { total, positions: withWeights, breaches };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** One-line objective for the Task a breach produces (stable => idempotency key). */
export function breachObjective(breach: ConcentrationBreach, maxWeight: number): string {
  const pct = (breach.weight * 100).toFixed(1);
  const cap = (maxWeight * 100).toFixed(0);
  return `Review concentration: ${breach.symbol} is ${pct}% of the portfolio (target max ${cap}%)`;
}
