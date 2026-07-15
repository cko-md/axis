import { describe, expect, it } from "vitest";
import {
  MICRO_SHARES_PER_SHARE,
  applySplit,
  costBasisFifo,
  costBasisSpecific,
  realizedGain,
  recordCashDividend,
  recordReinvestedDividend,
  type TaxLot,
  unrealizedGain,
} from "./taxLots";

const S = MICRO_SHARES_PER_SHARE;

/** Build a lot with sensible defaults; override only what a test cares about. */
function lot(overrides: Partial<TaxLot> & Pick<TaxLot, "id">): TaxLot {
  return {
    symbol: "ACME",
    acquiredAt: "2026-01-01T00:00:00Z",
    quantityMicro: S,
    costBasisMinor: 10000,
    currency: "USD",
    ...overrides,
  };
}

/** Sum the basis of a set of lots — used to assert conservation. */
function totalBasis(lots: readonly TaxLot[]): number {
  return lots.reduce((sum, l) => sum + l.costBasisMinor, 0);
}

describe("taxLots — conservation of basis under FIFO partial sales", () => {
  it("adversarial: 3 shares basis 1000, sell 1 — no cent created or destroyed", () => {
    const lots = [lot({ id: "a", quantityMicro: 3 * S, costBasisMinor: 1000 })];
    const r = costBasisFifo(lots, 1 * S);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 1000 * 1/3 = 333.33 -> 333 consumed; 667 stays with the reduced lot.
    expect(r.value.costBasisMinor).toBe(333);
    expect(r.value.remainingLots).toHaveLength(1);
    expect(r.value.remainingLots[0].costBasisMinor).toBe(667);
    expect(r.value.remainingLots[0].quantityMicro).toBe(2 * S);
    // Core invariant: consumed + remaining === original, exactly.
    expect(r.value.costBasisMinor + totalBasis(r.value.remainingLots)).toBe(1000);
  });

  it("conserves basis across many adversarial sell amounts", () => {
    const original = 1000;
    for (const sellShares of [1, 2, 1.5, 0.1, 2.999999, 2.5]) {
      const lots = [lot({ id: "a", quantityMicro: 3 * S, costBasisMinor: original })];
      const r = costBasisFifo(lots, Math.round(sellShares * S));
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.value.costBasisMinor + totalBasis(r.value.remainingLots)).toBe(original);
    }
  });

  it("conserves basis spanning multiple lots with a partial tail", () => {
    const lots = [
      lot({ id: "a", acquiredAt: "2026-01-01T00:00:00Z", quantityMicro: 2 * S, costBasisMinor: 700 }),
      lot({ id: "b", acquiredAt: "2026-02-01T00:00:00Z", quantityMicro: 3 * S, costBasisMinor: 1100 }),
    ];
    const r = costBasisFifo(lots, Math.round(3.5 * S)); // all of a, half of b
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.consumedLots.map((c) => c.lotId)).toEqual(["a", "b"]);
    expect(r.value.costBasisMinor + totalBasis(r.value.remainingLots)).toBe(1800);
  });

  it("fully consumes all lots when selling the entire holding", () => {
    const lots = [
      lot({ id: "a", quantityMicro: 2 * S, costBasisMinor: 500 }),
      lot({ id: "b", quantityMicro: 1 * S, costBasisMinor: 333 }),
    ];
    const r = costBasisFifo(lots, 3 * S);
    expect(r.ok && r.value.costBasisMinor).toBe(833);
    expect(r.ok && r.value.remainingLots).toEqual([]);
  });
});

describe("taxLots — FIFO ordering", () => {
  it("consumes the oldest acquiredAt first regardless of input order", () => {
    const lots = [
      lot({ id: "new", acquiredAt: "2026-06-01T00:00:00Z", quantityMicro: 1 * S, costBasisMinor: 200 }),
      lot({ id: "old", acquiredAt: "2026-01-01T00:00:00Z", quantityMicro: 1 * S, costBasisMinor: 100 }),
      lot({ id: "mid", acquiredAt: "2026-03-01T00:00:00Z", quantityMicro: 1 * S, costBasisMinor: 150 }),
    ];
    const r = costBasisFifo(lots, Math.round(1.5 * S));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Oldest ("old") fully, then half of "mid".
    expect(r.value.consumedLots.map((c) => c.lotId)).toEqual(["old", "mid"]);
    expect(r.value.consumedLots[0].costBasisMinor).toBe(100);
    expect(r.value.consumedLots[1].costBasisMinor).toBe(75); // 150 * 0.5
  });
});

describe("taxLots — stock splits preserve total basis, scale quantity exactly", () => {
  it("2:1 forward split doubles quantity, leaves total basis unchanged", () => {
    const lots = [lot({ id: "a", quantityMicro: 5 * S, costBasisMinor: 12345 })];
    const r = applySplit(lots, { numerator: 2, denominator: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value[0].quantityMicro).toBe(10 * S);
    expect(r.value[0].costBasisMinor).toBe(12345);
  });

  it("1:10 reverse split divides quantity by 10, leaves total basis unchanged", () => {
    const lots = [lot({ id: "a", quantityMicro: 100 * S, costBasisMinor: 98765 })];
    const r = applySplit(lots, { numerator: 1, denominator: 10 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value[0].quantityMicro).toBe(10 * S);
    expect(r.value[0].costBasisMinor).toBe(98765);
  });

  it("rounds fractional micro-shares half away from zero, never drifting basis", () => {
    // 1 share under a 2:1 split on an odd sub-quantity: 1/3 share = 333333 micro.
    const lots = [lot({ id: "a", quantityMicro: 333_333, costBasisMinor: 5000 })];
    const r = applySplit(lots, { numerator: 2, denominator: 1 });
    expect(r.ok && r.value[0].quantityMicro).toBe(666_666);
    expect(r.ok && r.value[0].costBasisMinor).toBe(5000);
  });

  it("does not mutate the input lots", () => {
    const lots = [lot({ id: "a", quantityMicro: 5 * S })];
    applySplit(lots, { numerator: 2, denominator: 1 });
    expect(lots[0].quantityMicro).toBe(5 * S);
  });

  it("rejects a non-positive or non-integer ratio", () => {
    const lots = [lot({ id: "a" })];
    expect(applySplit(lots, { numerator: 0, denominator: 1 }).ok).toBe(false);
    const r = applySplit(lots, { numerator: 1.5, denominator: 1 });
    expect(!r.ok && r.error.code).toBe("invalid_ratio");
  });
});

describe("taxLots — dividends", () => {
  it("cash dividend returns total cash, leaves basis untouched", () => {
    const lots = [
      lot({ id: "a", quantityMicro: 10 * S, costBasisMinor: 5000 }),
      lot({ id: "b", quantityMicro: 5 * S, costBasisMinor: 2500 }),
    ];
    // $0.50/share over 15 shares = $7.50 = 750 minor.
    const r = recordCashDividend(50, lots);
    expect(r.ok && r.value).toBe(750);
    // Lots are unchanged (basis conserved — income is separate).
    expect(totalBasis(lots)).toBe(7500);
  });

  it("cash dividend scales fractional micro-share holdings and rounds once", () => {
    // 1.5 shares at 33 minor/share = 49.5 minor -> 50 (half away from zero).
    const lots = [lot({ id: "a", quantityMicro: Math.round(1.5 * S), costBasisMinor: 1000 })];
    const r = recordCashDividend(33, lots);
    expect(r.ok && r.value).toBe(50);
  });

  it("reinvested dividend creates a new lot whose basis is the cash amount", () => {
    const r = recordReinvestedDividend({
      id: "drip-1",
      symbol: "ACME",
      cashAmountMinor: 750,
      pricePerShareMinor: 5000, // $50.00/share
      acquiredAt: "2026-03-15T00:00:00Z",
      currency: "USD",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.costBasisMinor).toBe(750); // basis === cash reinvested
    // 750 / 5000 = 0.15 share = 150000 micro-shares.
    expect(r.value.quantityMicro).toBe(150_000);
    expect(r.value.symbol).toBe("ACME");
  });

  it("reinvested dividend increases total basis by exactly the cash amount", () => {
    const existing = [lot({ id: "a", quantityMicro: 10 * S, costBasisMinor: 5000 })];
    const r = recordReinvestedDividend({
      id: "drip-1",
      symbol: "ACME",
      cashAmountMinor: 750,
      pricePerShareMinor: 5000,
      acquiredAt: "2026-03-15T00:00:00Z",
      currency: "USD",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const after = [...existing, r.value];
    expect(totalBasis(after)).toBe(5000 + 750);
  });

  it("reinvested dividend rejects a non-positive price", () => {
    const r = recordReinvestedDividend({
      id: "x",
      symbol: "ACME",
      cashAmountMinor: 750,
      pricePerShareMinor: 0,
      acquiredAt: "2026-03-15T00:00:00Z",
      currency: "USD",
    });
    expect(!r.ok && r.error.code).toBe("invalid_quantity");
  });
});

describe("taxLots — specific identification", () => {
  it("sells named quantities from named lots, conserving basis", () => {
    const lots = [
      lot({ id: "a", quantityMicro: 4 * S, costBasisMinor: 1000 }),
      lot({ id: "b", quantityMicro: 4 * S, costBasisMinor: 2000 }),
    ];
    const r = costBasisSpecific(lots, ["b"], [1 * S]); // sell 1 share from the pricier lot
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.costBasisMinor).toBe(500); // 2000 * 1/4
    expect(r.value.consumedLots).toEqual([{ lotId: "b", quantityMicro: 1 * S, costBasisMinor: 500 }]);
    // a untouched, b reduced; conservation across the whole set.
    expect(r.value.costBasisMinor + totalBasis(r.value.remainingLots)).toBe(3000);
  });

  it("aggregates repeated ids and rejects unknown lot ids", () => {
    const lots = [lot({ id: "a", quantityMicro: 4 * S, costBasisMinor: 1000 })];
    const dup = costBasisSpecific(lots, ["a", "a"], [1 * S, 1 * S]);
    expect(dup.ok && dup.value.consumedLots[0].quantityMicro).toBe(2 * S);

    const unknown = costBasisSpecific(lots, ["ghost"], [1 * S]);
    expect(!unknown.ok && unknown.error.code).toBe("unknown_lot");
  });

  it("rejects mismatched array lengths", () => {
    const lots = [lot({ id: "a" })];
    const r = costBasisSpecific(lots, ["a"], [1 * S, 2 * S]);
    expect(!r.ok && r.error.code).toBe("invalid_quantity");
  });
});

describe("taxLots — typed errors", () => {
  it("selling more than held returns insufficient_quantity", () => {
    const lots = [lot({ id: "a", quantityMicro: 2 * S, costBasisMinor: 1000 })];
    const r = costBasisFifo(lots, 3 * S);
    expect(!r.ok && r.error.code).toBe("insufficient_quantity");
  });

  it("mixed-currency lots cannot be combined without an FX rate", () => {
    const lots = [
      lot({ id: "a", currency: "USD", quantityMicro: 1 * S, costBasisMinor: 1000 }),
      lot({ id: "b", currency: "EUR", quantityMicro: 1 * S, costBasisMinor: 1000 }),
    ];
    const fifo = costBasisFifo(lots, 1 * S);
    expect(!fifo.ok && fifo.error.code).toBe("mixed_currency");
    const div = recordCashDividend(50, lots);
    expect(!div.ok && div.error.code).toBe("mixed_currency");
    const ug = unrealizedGain(lots, 6000);
    expect(!ug.ok && ug.error.code).toBe("mixed_currency");
  });

  it("duplicate lot ids are rejected", () => {
    const lots = [lot({ id: "a" }), lot({ id: "a" })];
    const r = costBasisFifo(lots, 1 * S);
    expect(!r.ok && r.error.code).toBe("duplicate_lot");
  });

  it("non-positive sell quantity is invalid", () => {
    const lots = [lot({ id: "a" })];
    expect(!costBasisFifo(lots, 0).ok).toBe(true);
    expect(!costBasisFifo(lots, -1).ok).toBe(true);
  });
});

describe("taxLots — gains", () => {
  it("realized gain is proceeds minus basis (loss is negative)", () => {
    expect(realizedGain(12000, 10000)).toBe(2000);
    expect(realizedGain(8000, 10000)).toBe(-2000);
  });

  it("unrealized gain marks lots to a current price", () => {
    const lots = [
      lot({ id: "a", quantityMicro: 10 * S, costBasisMinor: 5000 }),
      lot({ id: "b", quantityMicro: 5 * S, costBasisMinor: 3000 }),
    ];
    // 15 shares marked at $6.00 = 9000 minor; basis 8000 -> +1000.
    const r = unrealizedGain(lots, 600);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.marketValueMinor).toBe(9000);
    expect(r.value.costBasisMinor).toBe(8000);
    expect(r.value.unrealizedGainMinor).toBe(1000);
  });

  it("unrealized gain of an empty holding is zero", () => {
    const r = unrealizedGain([], 600);
    expect(r.ok && r.value).toEqual({
      marketValueMinor: 0,
      costBasisMinor: 0,
      unrealizedGainMinor: 0,
    });
  });
});
