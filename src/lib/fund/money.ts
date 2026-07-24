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
 * ISO-4217 minor-unit exponents used by AXIS provider integrations.
 *
 * Unknown currencies are rejected by the strict financial-truth functions.
 * This is deliberate: silently assuming two decimals corrupts JPY/KRW and
 * three-decimal currencies. Add a currency here only after the provider
 * contract for it is verified.
 */
export const ISO_MINOR_UNIT_EXPONENT = {
  AUD: 2,
  BHD: 3,
  BRL: 2,
  CAD: 2,
  CHF: 2,
  CLP: 0,
  CNY: 2,
  CZK: 2,
  DKK: 2,
  EUR: 2,
  GBP: 2,
  HKD: 2,
  HUF: 2,
  IDR: 2,
  ILS: 2,
  INR: 2,
  ISK: 0,
  JOD: 3,
  JPY: 0,
  KRW: 0,
  KWD: 3,
  MXN: 2,
  MYR: 2,
  NOK: 2,
  NZD: 2,
  OMR: 3,
  PHP: 2,
  PLN: 2,
  RON: 2,
  SEK: 2,
  SGD: 2,
  THB: 2,
  TRY: 2,
  TWD: 2,
  USD: 2,
  VND: 0,
  ZAR: 2,
} as const;

export type SupportedCurrency = keyof typeof ISO_MINOR_UNIT_EXPONENT;

export class MoneyValueError extends Error {
  readonly code:
    | "UNSUPPORTED_CURRENCY"
    | "INVALID_DECIMAL"
    | "UNSAFE_NUMBER"
    | "UNSAFE_MAJOR_UNIT_CONVERSION";

  constructor(code: MoneyValueError["code"], message: string) {
    super(message);
    this.name = "MoneyValueError";
    this.code = code;
  }
}

export function normalizeCurrency(value: unknown): SupportedCurrency {
  const currency = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!(currency in ISO_MINOR_UNIT_EXPONENT)) {
    throw new MoneyValueError("UNSUPPORTED_CURRENCY", "Currency is not supported by the exact-money registry");
  }
  return currency as SupportedCurrency;
}

function decimalParts(value: string): {
  negative: boolean;
  digits: string;
  fractionalDigits: number;
  exponent: number;
} {
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(value.trim());
  if (!match) {
    throw new MoneyValueError("INVALID_DECIMAL", "Money value must be a finite base-10 decimal");
  }
  const exponent = Number(match[4] ?? "0");
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1_000) {
    throw new MoneyValueError("INVALID_DECIMAL", "Money exponent is outside the supported range");
  }
  const fraction = match[3] ?? "";
  const digits = `${match[2]}${fraction}`.replace(/^0+(?=\d)/, "");
  return {
    negative: match[1] === "-",
    digits,
    fractionalDigits: fraction.length,
    exponent,
  };
}

function roundHalfAwayFromZeroBigInt(
  magnitude: bigint,
  discarded: string,
): bigint {
  return discarded.length > 0 && discarded[0] >= "5" ? magnitude + BigInt(1) : magnitude;
}

/**
 * Convert a provider/user major-unit decimal into exact integer minor units.
 *
 * The result is BigInt and therefore never silently overflows
 * Number.MAX_SAFE_INTEGER. Inputs with more precision than the currency permits
 * are rounded once, half away from zero, at this boundary.
 */
export function majorToMinorExact(
  value: string | number,
  currencyValue: unknown,
): bigint {
  const currency = normalizeCurrency(currencyValue);
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new MoneyValueError("INVALID_DECIMAL", "Money value must be finite");
  }
  if (typeof value === "number" && !Number.isSafeInteger(value) && Number.isInteger(value)) {
    throw new MoneyValueError(
      "UNSAFE_NUMBER",
      "Integer money inputs beyond Number.MAX_SAFE_INTEGER must be supplied as strings",
    );
  }

  const { negative, digits, fractionalDigits, exponent } = decimalParts(String(value));
  const currencyExponent = ISO_MINOR_UNIT_EXPONENT[currency];
  const effectiveScale = fractionalDigits - exponent;
  const shift = currencyExponent - effectiveScale;

  let magnitude: bigint;
  if (shift >= 0) {
    magnitude = BigInt(digits) * BigInt(10) ** BigInt(shift);
  } else {
    const remove = -shift;
    const padded = digits.padStart(remove + 1, "0");
    const kept = padded.slice(0, padded.length - remove);
    const discarded = padded.slice(padded.length - remove);
    magnitude = roundHalfAwayFromZeroBigInt(BigInt(kept || "0"), discarded);
  }
  return negative && magnitude !== BigInt(0) ? -magnitude : magnitude;
}

/** Validate and normalize an integer-minor-unit value received from storage. */
export function parseMinorExact(value: string | bigint): bigint {
  if (typeof value === "bigint") return value;
  if (!/^-?\d+$/.test(value)) {
    throw new MoneyValueError("INVALID_DECIMAL", "Minor-unit value must be an integer string");
  }
  return BigInt(value);
}

/** Format exact minor units as a base-10 major-unit string without Number. */
export function minorToMajorExact(
  value: string | bigint,
  currencyValue: unknown,
): string {
  const currency = normalizeCurrency(currencyValue);
  const exponent = ISO_MINOR_UNIT_EXPONENT[currency];
  const minor = parseMinorExact(value);
  const negative = minor < BigInt(0);
  const digits = (negative ? -minor : minor).toString();
  if (exponent === 0) return `${negative ? "-" : ""}${digits}`;
  const padded = digits.padStart(exponent + 1, "0");
  return `${negative ? "-" : ""}${padded.slice(0, -exponent)}.${padded.slice(-exponent)}`;
}

/**
 * Convert minor units to a display Number only after proving the integer is
 * safely representable. Calculations and persistence must continue to use
 * BigInt/string.
 */
export function minorToSafeMajorNumber(
  value: string | bigint,
  currencyValue: unknown,
): number {
  const minor = parseMinorExact(value);
  if (minor > BigInt(Number.MAX_SAFE_INTEGER) || minor < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new MoneyValueError(
      "UNSAFE_MAJOR_UNIT_CONVERSION",
      "Minor-unit value exceeds Number.MAX_SAFE_INTEGER",
    );
  }
  return Number(minorToMajorExact(minor, currencyValue));
}

/** Sum exact minor-unit strings without crossing a floating-point boundary. */
export function sumMinorExact(values: Iterable<string | bigint>): bigint {
  let total = BigInt(0);
  for (const value of values) total += parseMinorExact(value);
  return total;
}

/**
 * Round half away from zero — the convention used for currency rounding
 * ("round half up" for positives, "round half down" for negatives), which keeps
 * `roundHalfAwayFromZero(-2.5) === -3` symmetric with `+2.5 -> +3`. This avoids
 * banker's-rounding surprises in user-facing totals.
 */
export function roundHalfAwayFromZero(value: number): number {
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
