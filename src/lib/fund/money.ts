/**
 * Deterministic money utilities for the Fund (finance) module.
 *
 * Money in Axis is stored and returned by providers (Plaid, Public, manual
 * entry) as major-unit numbers — e.g. `42.5` dollars. JavaScript numbers are
 * IEEE-754 binary floats, so naive aggregation (`amounts.reduce((s, a) => s + a, 0)`)
 * silently drifts: `0.1 + 0.2 === 0.30000000000000004`. Over a net-worth roll-up
 * of hundreds of balances that drift becomes a visible, wrong cent.
 *
 * The rule (see docs/axis-redesign/04-target-architecture.md, "deterministic
 * calculation services"): do arithmetic on integer **minor units** (cents), then
 * convert back to major units only at the display boundary. AI may explain a
 * number but must never be the authoritative engine that produces it.
 *
 * These helpers are intentionally dependency-free and pure so they can be unit
 * tested as financial invariants and reused by any aggregation site.
 */

/** Number of minor units per major unit. USD/EUR/GBP == 100 (cents). */
const MINOR_UNITS_PER_MAJOR = 100;

/**
 * Round half away from zero — the convention used for currency rounding
 * ("round half up" for positives, "round half down" for negatives), which keeps
 * `roundHalfAwayFromZero(-2.5) === -3` symmetric with `+2.5 -> +3`. This avoids
 * banker's-rounding surprises in user-facing totals.
 */
function roundHalfAwayFromZero(value: number): number {
  return Math.sign(value) * Math.round(Math.abs(value));
}

/**
 * Parse an untrusted value (string, number, provider payload) into an integer
 * number of minor units (cents). Invalid / non-finite input returns 0, matching
 * the existing `safeMoney` contract so callers never propagate NaN into a total.
 *
 * Examples: `"42.50" -> 4250`, `42.505 -> 4251` (rounds to nearest cent),
 * `"$1,299.99" -> 129999`, `"not money" -> 0`, `Infinity -> 0`.
 */
export function toMinorUnits(value: unknown): number {
  let amount: number;
  if (typeof value === "number") {
    amount = value;
  } else if (typeof value === "string") {
    // Tolerate currency symbols, thousands separators and surrounding space.
    const cleaned = value.replace(/[^0-9.+-]/g, "");
    amount = cleaned === "" ? Number.NaN : Number(cleaned);
  } else {
    amount = Number(value);
  }
  if (!Number.isFinite(amount)) return 0;
  return roundHalfAwayFromZero(amount * MINOR_UNITS_PER_MAJOR);
}

/** Convert integer minor units back to a major-unit number (e.g. `4250 -> 42.5`). */
export function toMajorUnits(minor: number): number {
  if (!Number.isFinite(minor)) return 0;
  return roundHalfAwayFromZero(minor) / MINOR_UNITS_PER_MAJOR;
}

/**
 * Parse an untrusted value into a normalized major-unit number, rounded to the
 * cent. Drop-in, precision-safe replacement for ad-hoc `Number(value)` money
 * parsing. Invalid input returns 0.
 */
export function parseMoney(value: unknown): number {
  return toMajorUnits(toMinorUnits(value));
}

/**
 * Exact sum of a list of major-unit money amounts. Each amount is parsed to
 * minor units, summed as integers (no float drift), then converted back.
 *
 * Financial invariant: `sumMoney([0.1, 0.2]) === 0.3` exactly, and summing N
 * amounts is order-independent and never accumulates rounding error.
 */
export function sumMoney(values: Iterable<unknown>): number {
  let minorTotal = 0;
  for (const value of values) {
    minorTotal += toMinorUnits(value);
  }
  return toMajorUnits(minorTotal);
}

/**
 * Sum a list by projecting each item to a money amount first — convenience for
 * the common `rows.reduce((s, r) => s + Number(r.balance), 0)` pattern.
 */
export function sumBy<T>(items: Iterable<T>, select: (item: T) => unknown): number {
  let minorTotal = 0;
  for (const item of items) {
    minorTotal += toMinorUnits(select(item));
  }
  return toMajorUnits(minorTotal);
}
