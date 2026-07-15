/**
 * Currency-aware minor-unit conversion for the Fund (finance) module.
 *
 * {@link ./money} assumes 100 minor units per major unit — correct for USD, EUR,
 * GBP and most currencies, but wrong for the zero-decimal (JPY has no "sen":
 * ¥1234 is 1234 minor units, not 123400) and three-decimal (Bahraini dinar has
 * 1000 fils to the dinar) currencies. Before Axis can hold balances in more than
 * one currency, minor-unit arithmetic has to know each currency's exponent.
 *
 * This module is the ISO-4217 exponent table plus currency-aware variants of
 * `toMinorUnits` / `toMajorUnits`. It reuses {@link roundHalfAwayFromZero} from
 * {@link ./money} so every site rounds identically. It is intentionally pure and
 * dependency-free (no I/O, no network, no `Date.now()`) so the rules are unit
 * testable as financial invariants.
 *
 * It does NOT convert between currencies — that requires an explicit FX rate and
 * lives in {@link ./fx}. Mixing two currencies without a rate is never allowed.
 */

import { roundHalfAwayFromZero } from "./money";

/**
 * Number of decimal places (ISO-4217 exponent) for currencies that are not the
 * default two. Codes absent from this table default to 2 (see {@link minorUnitsFor}).
 *
 * Sources: ISO 4217. Kept to the exponents that actually differ from 2 — the
 * common zero-decimal and three-decimal currencies — so the table stays a
 * maintainable exception list rather than an exhaustive enumeration.
 */
export const CURRENCY_EXPONENTS: Readonly<Record<string, number>> = Object.freeze({
  // Zero-decimal currencies (no minor unit in practice).
  BIF: 0, // Burundian franc
  CLP: 0, // Chilean peso
  DJF: 0, // Djiboutian franc
  GNF: 0, // Guinean franc
  ISK: 0, // Icelandic króna
  JPY: 0, // Japanese yen
  KMF: 0, // Comorian franc
  KRW: 0, // South Korean won
  PYG: 0, // Paraguayan guaraní
  RWF: 0, // Rwandan franc
  UGX: 0, // Ugandan shilling
  VND: 0, // Vietnamese đồng
  VUV: 0, // Vanuatu vatu
  XAF: 0, // Central African CFA franc
  XOF: 0, // West African CFA franc
  XPF: 0, // CFP franc
  // Three-decimal currencies (1000 minor units per major).
  BHD: 3, // Bahraini dinar
  IQD: 3, // Iraqi dinar
  JOD: 3, // Jordanian dinar
  KWD: 3, // Kuwaiti dinar
  LYD: 3, // Libyan dinar
  OMR: 3, // Omani rial
  TND: 3, // Tunisian dinar
});

/** Default exponent for any currency not listed in {@link CURRENCY_EXPONENTS}. */
export const DEFAULT_CURRENCY_EXPONENT = 2;

/**
 * The full minor-unit factor table (10 ** exponent), for callers that want the
 * multiplier directly (e.g. `100`, `1`, `1000`) rather than the exponent.
 * Derived from {@link CURRENCY_EXPONENTS}; unlisted codes still default to 100.
 */
export const CURRENCY_MINOR_UNITS: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(
    Object.entries(CURRENCY_EXPONENTS).map(([code, exp]) => [code, 10 ** exp]),
  ),
);

/** Normalize a currency code for lookup: trim surrounding space, upper-case. */
function normalizeCode(currency: string): string {
  return currency.trim().toUpperCase();
}

/**
 * ISO-4217 exponent (decimal places) for a currency code. Case-insensitive and
 * whitespace-tolerant. **Unknown codes default to {@link DEFAULT_CURRENCY_EXPONENT}
 * (2)** — the overwhelmingly common case — so a typo or an unseen currency never
 * throws; callers that must reject unknown currencies should validate separately.
 */
export function exponentFor(currency: string): number {
  const code = normalizeCode(currency);
  return code in CURRENCY_EXPONENTS ? CURRENCY_EXPONENTS[code] : DEFAULT_CURRENCY_EXPONENT;
}

/**
 * Number of minor units per major unit for a currency (`100` for USD, `1` for
 * JPY, `1000` for BHD). Case-insensitive; **unknown codes default to 100**.
 */
export function minorUnitsFor(currency: string): number {
  return 10 ** exponentFor(currency);
}

/**
 * Parse an untrusted value into an integer number of minor units **in the given
 * currency's exponent**. The currency-aware sibling of
 * {@link import("./money").toMinorUnits}: `toMinorUnitsIn(1234, "JPY") === 1234`,
 * `toMinorUnitsIn("42.50", "USD") === 4250`, `toMinorUnitsIn("1.234", "BHD") === 1234`.
 *
 * Same tolerance and safety contract as `toMinorUnits`: currency symbols and
 * thousands separators are stripped, and invalid / non-finite input returns 0 so
 * callers never propagate NaN into a total. Rounds half away from zero to the
 * currency's smallest unit.
 */
export function toMinorUnitsIn(value: unknown, currency: string): number {
  let amount: number;
  if (typeof value === "number") {
    amount = value;
  } else if (typeof value === "string") {
    const cleaned = value.replace(/[^0-9.+-]/g, "");
    amount = cleaned === "" ? Number.NaN : Number(cleaned);
  } else {
    amount = Number(value);
  }
  if (!Number.isFinite(amount)) return 0;
  return roundHalfAwayFromZero(amount * minorUnitsFor(currency));
}

/**
 * Convert integer minor units back to a major-unit number for the given currency
 * (`toMajorUnitsIn(1234, "JPY") === 1234`, `toMajorUnitsIn(4250, "USD") === 42.5`,
 * `toMajorUnitsIn(1234, "BHD") === 1.234`). Invalid / non-finite input returns 0.
 */
export function toMajorUnitsIn(minor: number, currency: string): number {
  if (!Number.isFinite(minor)) return 0;
  return roundHalfAwayFromZero(minor) / minorUnitsFor(currency);
}
