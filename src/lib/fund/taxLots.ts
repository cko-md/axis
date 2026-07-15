/**
 * Deterministic tax-lot / cost-basis / corporate-actions domain for the Fund
 * (finance) module.
 *
 * When you buy a security you open a **tax lot**: a parcel of shares with an
 * acquisition date and a total cost basis. Selling, splitting, and reinvesting
 * dividends all transform lots, and every transform has to conserve money to the
 * cent — a partial sale must not create or destroy a single cent of basis, or the
 * eventual capital-gains number is wrong. That conservation is the core invariant
 * this module exists to guarantee.
 *
 * The safety kernel (see docs/axis-redesign/04-target-architecture.md,
 * "deterministic calculation services") requires:
 *  - All money arithmetic on integer **minor units** (cents). We reuse
 *    {@link roundHalfAwayFromZero} from {@link ./money} so every rounding site
 *    rounds identically to the rest of the Fund module.
 *  - Determinism: no `Date.now()` in the math. Acquisition timestamps live on the
 *    lots and are supplied by the caller.
 *  - No silent currency mixing: combining lots of different currencies without an
 *    FX rate is an **error value**, never a fallback (mirrors {@link ./fx}).
 *
 * Share quantities are NOT money. A dollar has exactly 100 cents; a share can be
 * split 1-for-3 and held fractionally, so a "cents"-style fixed exponent is the
 * wrong model. We represent quantities as integer **micro-shares** at a fixed
 * 1e6 precision ({@link MICRO_SHARES_PER_SHARE}). Integers never drift under the
 * repeated multiply/divide of splits the way IEEE-754 fractional shares would.
 *
 * This module is pure and dependency-free: no I/O, no database, no clock. Persisting
 * lots is a separate, migration-gated wave; this defines the typed shapes and the
 * pure transforms those columns will feed.
 */

import { roundHalfAwayFromZero } from "./money";

/**
 * Fixed-precision scale for share quantities: 1 whole share == 1_000_000
 * micro-shares. Chosen so that common splits (2:1, 3:1, 3:2, 1:10) and typical
 * fractional-share holdings stay exact as integers, with headroom before any
 * realistic quantity approaches `Number.MAX_SAFE_INTEGER`.
 */
export const MICRO_SHARES_PER_SHARE = 1_000_000;

/**
 * A parcel of shares acquired together, with its own cost basis. `costBasisMinor`
 * is the TOTAL basis for the whole lot (not per share), in integer minor units of
 * `currency`. `quantityMicro` is the share count in integer micro-shares.
 */
export type TaxLot = {
  /** Stable identifier for the lot (for specific-identification sales/audit). */
  id: string;
  /** Ticker / instrument symbol the lot holds. */
  symbol: string;
  /** ISO-8601 timestamp the lot was acquired (drives FIFO ordering). */
  acquiredAt: string;
  /** Share quantity in integer micro-shares (see {@link MICRO_SHARES_PER_SHARE}). */
  quantityMicro: number;
  /** Total cost basis for the whole lot, integer minor units of `currency`. */
  costBasisMinor: number;
  /** ISO-4217 currency the basis is denominated in. */
  currency: string;
};

/** A forward or reverse split ratio: each old share becomes `numerator/denominator` new shares. */
export type SplitRatio = {
  /** New shares per `denominator` old shares. 2:1 forward => 2; 1:10 reverse => 1. */
  numerator: number;
  /** Old shares the numerator is stated against. 2:1 forward => 1; 1:10 reverse => 10. */
  denominator: number;
};

/** Per-lot record of shares consumed by a sale and the basis allocated to them. */
export type ConsumedLot = {
  /** Id of the lot the shares came from. */
  lotId: string;
  /** Shares consumed from that lot, integer micro-shares. */
  quantityMicro: number;
  /** Cost basis allocated to those shares, integer minor units. */
  costBasisMinor: number;
};

/**
 * Outcome of a cost-basis computation over a sale.
 *
 * Conservation invariant: `costBasisMinor` (sum over `consumedLots`) plus the
 * summed `costBasisMinor` of `remainingLots` EXACTLY equals the summed basis of
 * the original lots — no cent is created or destroyed.
 */
export type CostBasis = {
  /** Total basis of the sold shares, integer minor units (sum of consumedLots). */
  costBasisMinor: number;
  /** What was consumed, in consumption order. */
  consumedLots: ConsumedLot[];
  /** Lots left after the sale: reduced partial lots + untouched lots, original order. */
  remainingLots: TaxLot[];
};

/** Components of an unrealized (mark-to-market) gain for a set of lots. */
export type UnrealizedGain = {
  /** Marked market value of all lots at the supplied price, integer minor units. */
  marketValueMinor: number;
  /** Total cost basis of all lots, integer minor units. */
  costBasisMinor: number;
  /** `marketValueMinor - costBasisMinor`, integer minor units (may be negative). */
  unrealizedGainMinor: number;
};

/** Typed failure reasons a computation can return instead of a value. */
export type TaxLotErrorCode =
  | "insufficient_quantity" // selling more shares than are held
  | "unknown_lot" // a referenced lot id is not in the supplied lots
  | "mixed_currency" // lots of differing currencies combined without an FX rate
  | "invalid_ratio" // split ratio non-finite, non-integer, or <= 0
  | "invalid_quantity" // a quantity/price is non-finite, non-integer, or <= 0
  | "duplicate_lot"; // the same lot id appears more than once in the lot set

/** A computation failure — safe to surface; never contains sensitive data. */
export type TaxLotError = {
  code: TaxLotErrorCode;
  message: string;
};

/** Result-style discriminated union returned by every fallible operation. */
export type TaxLotResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: TaxLotError };

function ok<T>(value: T): TaxLotResult<T> {
  return { ok: true, value };
}

function fail<T = never>(code: TaxLotErrorCode, message: string): TaxLotResult<T> {
  return { ok: false, error: { code, message } };
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

/**
 * Assert all lots share one currency, returning that currency or a `mixed_currency`
 * error. An empty set has no currency to disagree on and returns `null` — callers
 * that sum over an empty set treat the total as 0.
 */
function requireSingleCurrency(lots: readonly TaxLot[]): TaxLotResult<string | null> {
  if (lots.length === 0) return ok(null);
  const currency = lots[0].currency;
  for (const lot of lots) {
    if (lot.currency !== currency) {
      return fail(
        "mixed_currency",
        `Cannot combine lots of different currencies (${currency} vs ${lot.currency}) without an FX rate.`,
      );
    }
  }
  return ok(currency);
}

/** Assert no two lots share an id (specific-identification depends on unique ids). */
function requireUniqueIds(lots: readonly TaxLot[]): TaxLotResult<null> {
  const seen = new Set<string>();
  for (const lot of lots) {
    if (seen.has(lot.id)) {
      return fail("duplicate_lot", `Duplicate lot id "${lot.id}" in the supplied lots.`);
    }
    seen.add(lot.id);
  }
  return ok(null);
}

/**
 * Allocate a portion of a lot's total basis to a consumed sub-quantity,
 * proportionally, rounded half away from zero to the cent.
 *
 * Remainder rule: the CONSUMED portion is the one that gets rounded here; the
 * lot that keeps the residual is computed as `total - consumed` (never rounded
 * independently). That is what makes consumed + remaining conserve exactly. A
 * fully-consumed lot (consumed === total quantity) rounds to the whole basis, so
 * its remainder is exactly 0.
 */
function allocateBasis(
  totalBasisMinor: number,
  totalQuantityMicro: number,
  consumedQuantityMicro: number,
): number {
  if (consumedQuantityMicro >= totalQuantityMicro) return totalBasisMinor;
  return roundHalfAwayFromZero(
    (totalBasisMinor * consumedQuantityMicro) / totalQuantityMicro,
  );
}

/**
 * Apply a stock split (forward or reverse) to a set of lots.
 *
 * Each lot's quantity is scaled by `numerator/denominator` and rounded half away
 * from zero at micro-share precision (splits rarely divide evenly — a 1-for-3
 * holding under a 2:1 split lands on a fractional micro-share and must round). The
 * lot's TOTAL cost basis is UNCHANGED by a split: a split re-denominates the same
 * ownership into more/fewer shares, it does not change how much was paid.
 *
 * @param lots  The lots to split (not mutated; new lot objects are returned).
 * @param ratio New shares per old share, as `{ numerator, denominator }`. A 2:1
 *              forward split is `{ numerator: 2, denominator: 1 }`; a 1-for-10
 *              reverse split is `{ numerator: 1, denominator: 10 }`.
 * @returns new lots with scaled quantities, or `invalid_ratio` / `invalid_quantity`.
 */
export function applySplit(
  lots: readonly TaxLot[],
  ratio: SplitRatio,
): TaxLotResult<TaxLot[]> {
  if (!isPositiveInteger(ratio.numerator) || !isPositiveInteger(ratio.denominator)) {
    return fail(
      "invalid_ratio",
      "Split ratio numerator and denominator must be positive integers.",
    );
  }
  const scaled: TaxLot[] = [];
  for (const lot of lots) {
    if (!Number.isInteger(lot.quantityMicro)) {
      return fail(
        "invalid_quantity",
        `Lot "${lot.id}" has a non-integer micro-share quantity.`,
      );
    }
    const newQuantityMicro = roundHalfAwayFromZero(
      (lot.quantityMicro * ratio.numerator) / ratio.denominator,
    );
    scaled.push({ ...lot, quantityMicro: newQuantityMicro });
  }
  return ok(scaled);
}

/**
 * Record a cash dividend across a set of lots and return the total cash paid, in
 * integer minor units. A cash dividend is INCOME: it does not change any lot's
 * cost basis, so this returns only the cash total (the caller records it as
 * income; the lots are unchanged).
 *
 * `amountPerShareMinor` is the declared dividend per WHOLE share, in minor units
 * (e.g. a $0.50 dividend => 50). It is scaled internally by each lot's micro-share
 * holding: `perShareMinor * quantityMicro / MICRO_SHARES_PER_SHARE`. To avoid
 * per-lot rounding drift the exact integer products are summed first and rounded
 * to the cent exactly once at the end.
 *
 * All lots must share one currency (the dividend is denominated in it); mixed
 * currencies without an FX rate is a `mixed_currency` error.
 *
 * @param amountPerShareMinor Minor units of dividend per whole share (>= 0 integer).
 * @param lots                The lots receiving the dividend.
 * @returns total cash in minor units, or a typed error.
 */
export function recordCashDividend(
  amountPerShareMinor: number,
  lots: readonly TaxLot[],
): TaxLotResult<number> {
  if (!Number.isInteger(amountPerShareMinor) || amountPerShareMinor < 0) {
    return fail(
      "invalid_quantity",
      "Dividend per share must be a non-negative integer number of minor units.",
    );
  }
  const currency = requireSingleCurrency(lots);
  if (!currency.ok) return currency;

  let scaledTotal = 0; // sum of exact integer products, in minor-units * micro-shares
  for (const lot of lots) {
    if (!Number.isInteger(lot.quantityMicro)) {
      return fail(
        "invalid_quantity",
        `Lot "${lot.id}" has a non-integer micro-share quantity.`,
      );
    }
    scaledTotal += amountPerShareMinor * lot.quantityMicro;
  }
  return ok(roundHalfAwayFromZero(scaledTotal / MICRO_SHARES_PER_SHARE));
}

/** Inputs to open a new lot from a reinvested dividend. */
export type ReinvestedDividendInput = {
  /** Id for the newly created lot. */
  id: string;
  /** Symbol the reinvested shares are of. */
  symbol: string;
  /** Cash dividend being reinvested, integer minor units — becomes the new lot's basis. */
  cashAmountMinor: number;
  /** Purchase price per WHOLE share at reinvestment, integer minor units (> 0). */
  pricePerShareMinor: number;
  /** ISO-8601 acquisition timestamp for the new lot. */
  acquiredAt: string;
  /** ISO-4217 currency of the cash and price. */
  currency: string;
};

/**
 * Record a reinvested (DRIP) dividend by opening a NEW lot. The reinvested cash
 * becomes the new lot's cost basis exactly, and the share quantity is derived from
 * the reinvestment price: `quantityMicro = round(cashAmountMinor / pricePerShareMinor
 * * MICRO_SHARES_PER_SHARE)`. Unlike a cash dividend this INCREASES total basis (by
 * exactly `cashAmountMinor`) because new shares were purchased.
 *
 * @returns the new {@link TaxLot}, or `invalid_quantity` for a non-positive price
 *          or non-finite/negative cash amount.
 */
export function recordReinvestedDividend(
  input: ReinvestedDividendInput,
): TaxLotResult<TaxLot> {
  const { cashAmountMinor, pricePerShareMinor } = input;
  if (!Number.isInteger(cashAmountMinor) || cashAmountMinor < 0) {
    return fail(
      "invalid_quantity",
      "Reinvested cash amount must be a non-negative integer number of minor units.",
    );
  }
  if (!isPositiveInteger(pricePerShareMinor)) {
    return fail(
      "invalid_quantity",
      "Reinvestment price per share must be a positive integer number of minor units.",
    );
  }
  const quantityMicro = roundHalfAwayFromZero(
    (cashAmountMinor * MICRO_SHARES_PER_SHARE) / pricePerShareMinor,
  );
  return ok({
    id: input.id,
    symbol: input.symbol,
    acquiredAt: input.acquiredAt,
    quantityMicro,
    costBasisMinor: cashAmountMinor,
    currency: input.currency,
  });
}

/**
 * Compute cost basis for a sale using FIFO (first-in, first-out): the oldest lots
 * by `acquiredAt` are consumed first. Partially-consumed lots have their basis
 * allocated proportionally (see {@link allocateBasis}); the remainder stays with
 * the reduced lot so consumed + remaining conserves basis exactly.
 *
 * @param lots             The lots available to sell from (any order; sorted here).
 * @param sellQuantityMicro Shares to sell, integer micro-shares (> 0).
 * @returns a {@link CostBasis}, or `invalid_quantity` / `insufficient_quantity` /
 *          `mixed_currency` / `duplicate_lot`.
 */
export function costBasisFifo(
  lots: readonly TaxLot[],
  sellQuantityMicro: number,
): TaxLotResult<CostBasis> {
  if (!isPositiveInteger(sellQuantityMicro)) {
    return fail("invalid_quantity", "Sell quantity must be a positive integer of micro-shares.");
  }
  const unique = requireUniqueIds(lots);
  if (!unique.ok) return unique;
  const currency = requireSingleCurrency(lots);
  if (!currency.ok) return currency;

  const totalHeld = lots.reduce((sum, lot) => sum + lot.quantityMicro, 0);
  if (sellQuantityMicro > totalHeld) {
    return fail(
      "insufficient_quantity",
      `Cannot sell ${sellQuantityMicro} micro-shares; only ${totalHeld} held.`,
    );
  }

  // FIFO: oldest acquiredAt first. Ties broken by original order (stable sort).
  const ordered = [...lots].sort((a, b) => Date.parse(a.acquiredAt) - Date.parse(b.acquiredAt));

  const consumedLots: ConsumedLot[] = [];
  const remainingLots: TaxLot[] = [];
  let remainingToSell = sellQuantityMicro;
  let totalConsumedBasis = 0;

  for (const lot of ordered) {
    if (remainingToSell <= 0) {
      remainingLots.push(lot);
      continue;
    }
    const take = Math.min(lot.quantityMicro, remainingToSell);
    const consumedBasis = allocateBasis(lot.costBasisMinor, lot.quantityMicro, take);
    consumedLots.push({ lotId: lot.id, quantityMicro: take, costBasisMinor: consumedBasis });
    totalConsumedBasis += consumedBasis;
    remainingToSell -= take;

    if (take < lot.quantityMicro) {
      // Partial: the residual basis stays with the reduced lot — exact conservation.
      remainingLots.push({
        ...lot,
        quantityMicro: lot.quantityMicro - take,
        costBasisMinor: lot.costBasisMinor - consumedBasis,
      });
    }
    // Fully consumed lots are dropped from remainingLots.
  }

  return ok({ costBasisMinor: totalConsumedBasis, consumedLots, remainingLots });
}

/**
 * Compute cost basis for a sale using specific-identification: the caller names
 * exact lot ids and how many micro-shares to sell from each. `lotIds[i]` is sold
 * `quantities[i]` micro-shares; the two arrays are parallel and must be the same
 * length. Repeated ids are summed. Basis is allocated proportionally within each
 * named lot with the same residual rule as FIFO, so conservation holds exactly.
 *
 * @param lots       The lots available to sell from.
 * @param lotIds     Ids of the specific lots to sell from.
 * @param quantities Micro-shares to sell from each corresponding lot (> 0).
 * @returns a {@link CostBasis}, or `invalid_quantity` / `unknown_lot` /
 *          `insufficient_quantity` / `mixed_currency` / `duplicate_lot`.
 */
export function costBasisSpecific(
  lots: readonly TaxLot[],
  lotIds: readonly string[],
  quantities: readonly number[],
): TaxLotResult<CostBasis> {
  if (lotIds.length !== quantities.length) {
    return fail(
      "invalid_quantity",
      "lotIds and quantities must be parallel arrays of the same length.",
    );
  }
  const unique = requireUniqueIds(lots);
  if (!unique.ok) return unique;
  const currency = requireSingleCurrency(lots);
  if (!currency.ok) return currency;

  const byId = new Map(lots.map((lot) => [lot.id, lot]));

  // Aggregate requested quantities per lot id (repeated ids sum).
  const requested = new Map<string, number>();
  for (let i = 0; i < lotIds.length; i++) {
    const id = lotIds[i];
    const qty = quantities[i];
    if (!isPositiveInteger(qty)) {
      return fail(
        "invalid_quantity",
        `Quantity for lot "${id}" must be a positive integer of micro-shares.`,
      );
    }
    if (!byId.has(id)) {
      return fail("unknown_lot", `Unknown lot id "${id}".`);
    }
    requested.set(id, (requested.get(id) ?? 0) + qty);
  }

  // Validate each requested total against what the lot holds before consuming any.
  for (const [id, qty] of requested) {
    const lot = byId.get(id);
    if (lot != null && qty > lot.quantityMicro) {
      return fail(
        "insufficient_quantity",
        `Cannot sell ${qty} micro-shares from lot "${id}"; only ${lot.quantityMicro} held.`,
      );
    }
  }

  const consumedLots: ConsumedLot[] = [];
  const remainingLots: TaxLot[] = [];
  let totalConsumedBasis = 0;

  // Preserve original lot order in the output.
  for (const lot of lots) {
    const take = requested.get(lot.id) ?? 0;
    if (take === 0) {
      remainingLots.push(lot);
      continue;
    }
    const consumedBasis = allocateBasis(lot.costBasisMinor, lot.quantityMicro, take);
    consumedLots.push({ lotId: lot.id, quantityMicro: take, costBasisMinor: consumedBasis });
    totalConsumedBasis += consumedBasis;
    if (take < lot.quantityMicro) {
      remainingLots.push({
        ...lot,
        quantityMicro: lot.quantityMicro - take,
        costBasisMinor: lot.costBasisMinor - consumedBasis,
      });
    }
  }

  return ok({ costBasisMinor: totalConsumedBasis, consumedLots, remainingLots });
}

/**
 * Realized gain (or loss) on a sale: `proceedsMinor - costBasisMinor`, in integer
 * minor units. Both inputs must already be denominated in the same currency
 * (proceeds come from selling the very lots whose basis is passed). Negative
 * results are losses.
 */
export function realizedGain(proceedsMinor: number, costBasisMinor: number): number {
  return roundHalfAwayFromZero(proceedsMinor) - roundHalfAwayFromZero(costBasisMinor);
}

/**
 * Unrealized (mark-to-market) gain for a set of lots at a current price.
 * `markPriceMinor` is the price per WHOLE share in minor units; market value is
 * `sum(markPriceMinor * quantityMicro) / MICRO_SHARES_PER_SHARE`, rounded to the
 * cent exactly once. Basis is the summed lot basis. All lots must share a
 * currency (the mark is denominated in it) — `mixed_currency` otherwise.
 *
 * @returns {@link UnrealizedGain} components, or a typed error.
 */
export function unrealizedGain(
  lots: readonly TaxLot[],
  markPriceMinor: number,
): TaxLotResult<UnrealizedGain> {
  if (!Number.isInteger(markPriceMinor) || markPriceMinor < 0) {
    return fail(
      "invalid_quantity",
      "Mark price must be a non-negative integer number of minor units per share.",
    );
  }
  const currency = requireSingleCurrency(lots);
  if (!currency.ok) return currency;

  let scaledMarketValue = 0; // minor-units * micro-shares
  let costBasisMinor = 0;
  for (const lot of lots) {
    if (!Number.isInteger(lot.quantityMicro)) {
      return fail(
        "invalid_quantity",
        `Lot "${lot.id}" has a non-integer micro-share quantity.`,
      );
    }
    scaledMarketValue += markPriceMinor * lot.quantityMicro;
    costBasisMinor += lot.costBasisMinor;
  }
  const marketValueMinor = roundHalfAwayFromZero(scaledMarketValue / MICRO_SHARES_PER_SHARE);
  return ok({
    marketValueMinor,
    costBasisMinor,
    unrealizedGainMinor: marketValueMinor - costBasisMinor,
  });
}
