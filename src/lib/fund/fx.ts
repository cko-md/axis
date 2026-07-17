/**
 * Deterministic FX (foreign-exchange) conversion for the Fund (finance) module.
 *
 * The safety kernel (docs/axis-redesign/04-target-architecture.md) forbids
 * silently mixing currencies: any operation combining two currencies MUST carry
 * an explicit, provenance-bearing rate. The absence of a rate is an **error
 * value**, never a fallback of 1.0. A converted amount is only meaningful
 * alongside *which* rate produced it, *from where*, and *retrieved when* — so a
 * successful conversion carries that provenance through.
 *
 * This module is pure and dependency-free: no I/O, no network, no clock. Time
 * lives on the rate ({@link FxRate.retrievedAt}) and is supplied by the caller,
 * never read from `Date.now()` here.
 *
 * Conversion algorithm (single rounding step — no compounding float error):
 *
 *   toMinor = round( fromMinor * effectiveRate * 10 ** (toExponent - fromExponent) )
 *
 * i.e. the exact integer minor amount is scaled once — by the rate and by the
 * difference in the two currencies' ISO-4217 exponents — and rounded half away
 * from zero exactly once, at the end, to the target currency's smallest unit.
 * This is algebraically identical to fromMinor → fromMajor (÷10**fromExp) ×
 * rate → toMinor (×10**toExp) but avoids the intermediate rounding those steps
 * would each introduce.
 */

import { exponentFor, toMajorUnitsIn, toMinorUnitsIn } from "./currency";
import { roundHalfAwayFromZero } from "./money";
import type { Provenance } from "./provenance";

/**
 * A quoted FX rate with provenance. Field names align with {@link Provenance}
 * (`provider`, `retrievedAt`). Semantics: **1 unit of `base` = `rate` units of
 * `quote`.** e.g. `{ base: "USD", quote: "EUR", rate: 0.92 }` means $1 = €0.92.
 */
export type FxRate = {
  /** ISO-4217 code of the base currency (the "from" side of the quote). */
  base: string;
  /** ISO-4217 code of the quote currency (the "to" side of the quote). */
  quote: string;
  /** Units of `quote` per one unit of `base`. Must be finite and > 0. */
  rate: number;
  /** Source of the quote, e.g. "polygon", "ecb", "manual". */
  provider: string;
  /** ISO-8601 timestamp the rate was retrieved. */
  retrievedAt: string;
};

/** Typed failure reasons a conversion can return instead of a number. */
export type FxErrorCode =
  | "missing_rate" // cross-currency conversion attempted without a rate
  | "rate_pair_mismatch" // the rate's base/quote don't match the from/to pair
  | "invalid_rate" // rate is non-finite or <= 0
  | "invalid_amount"; // amount is non-finite (would poison the total)

/** A conversion failure — safe to surface; never contains sensitive data. */
export type FxError = {
  code: FxErrorCode;
  message: string;
};

/** A successful conversion and the provenance that authorizes it. */
export type FxConversion = {
  /** Converted amount, integer minor units in the TARGET currency's exponent. */
  amountMinor: number;
  /** Normalized (upper-cased) target currency code. */
  currency: string;
  /** The rate applied, or `null` for a same-currency identity conversion. */
  rate: FxRate | null;
  /** True when the rate was applied in its inverse direction (quote → base). */
  inverted: boolean;
  /** Provenance of the applied rate; `null` for identity conversions. */
  provenance: Provenance | null;
};

/** Result-style discriminated union returned by every conversion. */
export type FxResult =
  | { ok: true; value: FxConversion }
  | { ok: false; error: FxError };

function fail(code: FxErrorCode, message: string): FxResult {
  return { ok: false, error: { code, message } };
}

function normalizeCode(currency: string): string {
  return currency.trim().toUpperCase();
}

/**
 * Build the {@link Provenance} record for a rate applied to a converted amount.
 * The converted value is denominated in `targetCurrency`, and its trustworthiness
 * is that of the rate's source and retrieval time.
 */
export function fxRateProvenance(rate: FxRate, targetCurrency: string): Provenance {
  return {
    provider: rate.provider,
    retrievedAt: rate.retrievedAt,
    currency: normalizeCode(targetCurrency),
  };
}

/**
 * Convert an integer minor-unit amount from one currency to another using an
 * explicit, provenance-bearing rate.
 *
 * Rules:
 * - **Same currency** (`from === to`, case-insensitive): identity pass-through.
 *   Returns the amount unchanged with `rate: null` and requires NO rate.
 * - **Cross currency with no rate**: `missing_rate` error — never a 1.0 fallback.
 * - **Rate pair matches** (`rate.base === from` and `rate.quote === to`): the rate
 *   is applied directly.
 * - **Inverse rate** (`rate.base === to` and `rate.quote === from`): the reciprocal
 *   `1 / rate.rate` is applied. Rounding implication: the reciprocal is itself a
 *   float, so an A→B→A round-trip using `r` then `1/r` may differ by up to one
 *   minor unit (there is no exact inverse of an arbitrary decimal rate). Prefer a
 *   directly-quoted rate for the direction you need when exactness matters.
 * - **Anything else**: `rate_pair_mismatch`.
 * - **Rate non-finite or `<= 0`**: `invalid_rate`.
 * - **Amount non-finite**: `invalid_amount`.
 *
 * @param amountMinor  Integer minor units in `fromCurrency`'s exponent.
 * @param fromCurrency Source ISO-4217 code.
 * @param toCurrency   Target ISO-4217 code.
 * @param rate         The rate to apply; omit only for a same-currency conversion.
 */
export function convertMinorUnits(
  amountMinor: number,
  fromCurrency: string,
  toCurrency: string,
  rate?: FxRate | null,
): FxResult {
  if (!Number.isFinite(amountMinor)) {
    return fail("invalid_amount", "Amount to convert must be a finite number of minor units.");
  }

  const from = normalizeCode(fromCurrency);
  const to = normalizeCode(toCurrency);

  // Identity conversion: same currency needs no rate and cannot drift.
  if (from === to) {
    return {
      ok: true,
      value: {
        amountMinor: roundHalfAwayFromZero(amountMinor),
        currency: to,
        rate: null,
        inverted: false,
        provenance: null,
      },
    };
  }

  if (rate == null) {
    return fail("missing_rate", `No FX rate supplied to convert ${from} to ${to}.`);
  }

  const rateBase = normalizeCode(rate.base);
  const rateQuote = normalizeCode(rate.quote);

  let effectiveRate: number;
  let inverted: boolean;
  if (rateBase === from && rateQuote === to) {
    effectiveRate = rate.rate;
    inverted = false;
  } else if (rateBase === to && rateQuote === from) {
    // Use the inverse of the rate for the reverse direction.
    inverted = true;
    effectiveRate = Number.NaN; // set after the validity check below
  } else {
    return fail(
      "rate_pair_mismatch",
      `Rate ${rateBase}/${rateQuote} cannot convert ${from} to ${to}.`,
    );
  }

  if (!Number.isFinite(rate.rate) || rate.rate <= 0) {
    return fail("invalid_rate", "FX rate must be a finite number greater than zero.");
  }

  if (inverted) {
    effectiveRate = 1 / rate.rate;
  }

  // Single scaling + single rounding step. `10 ** (toExp - fromExp)` reconciles
  // the two currencies' minor-unit granularity without an intermediate round.
  const scale = 10 ** (exponentFor(to) - exponentFor(from));
  const converted = roundHalfAwayFromZero(amountMinor * effectiveRate * scale);

  return {
    ok: true,
    value: {
      amountMinor: converted,
      currency: to,
      rate,
      inverted,
      provenance: fxRateProvenance(rate, to),
    },
  };
}

/** A successful major-unit conversion for display boundaries. */
export type FxMoneyConversion = Omit<FxConversion, "amountMinor"> & {
  /** Converted amount as a major-unit number in the target currency. */
  amount: number;
};

/** Result-style union for {@link convertMoney}. */
export type FxMoneyResult =
  | { ok: true; value: FxMoneyConversion }
  | { ok: false; error: FxError };

/**
 * Display-boundary convenience wrapper around {@link convertMinorUnits}: takes a
 * major-unit amount (e.g. `100` USD), converts with the given rate, and returns
 * a major-unit amount in the target currency (e.g. `92.34` EUR) plus the same
 * provenance. Arithmetic still happens on integer minor units internally — the
 * major-unit values only exist at the boundary.
 *
 * @param amountMajor  Amount in `fromCurrency` major units (parsed leniently).
 * @param rate         The rate to apply; omit only for same-currency conversion.
 */
export function convertMoney(
  amountMajor: unknown,
  fromCurrency: string,
  toCurrency: string,
  rate?: FxRate | null,
): FxMoneyResult {
  const minor = toMinorUnitsIn(amountMajor, fromCurrency);
  const result = convertMinorUnits(minor, fromCurrency, toCurrency, rate);
  if (!result.ok) return result;
  const { amountMinor, ...rest } = result.value;
  return {
    ok: true,
    value: {
      ...rest,
      amount: toMajorUnitsIn(amountMinor, rest.currency),
    },
  };
}
