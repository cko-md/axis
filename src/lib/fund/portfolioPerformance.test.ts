import { describe, expect, it } from "vitest";
import {
  calculateAllocation,
  calculateMoneyWeightedReturn,
  calculateTimeWeightedReturn,
} from "./portfolioPerformance";

describe("portfolio performance — time-weighted return", () => {
  it("removes external contributions from period performance", () => {
    const result = calculateTimeWeightedReturn(
      [
        { date: "2026-01-01", value: 1000, currency: "USD" },
        { date: "2026-02-01", value: 1200, currency: "USD" },
        { date: "2026-03-01", value: 1210, currency: "USD" },
      ],
      [{ date: "2026-02-01", amount: 100, currency: "USD" }],
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.externalFlowMinor).toBe(10000);
      expect(result.value.periodReturns.map((period) => period.return)).toEqual([0.1, 0.00833333]);
      expect(result.value.return).toBe(0.10916667);
    }
  });

  it("uses integer minor units so sub-cent float drift cannot move returns", () => {
    const result = calculateTimeWeightedReturn(
      [
        { date: "2026-01-01", value: 0.1 + 0.2, currency: "USD" },
        { date: "2026-01-02", value: 0.6, currency: "USD" },
      ],
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.startValueMinor).toBe(30);
      expect(result.value.endValueMinor).toBe(60);
      expect(result.value.return).toBe(1);
    }
  });

  it("rejects mixed currencies instead of assuming an FX rate", () => {
    const result = calculateTimeWeightedReturn([
      { date: "2026-01-01", value: 1000, currency: "USD" },
      { date: "2026-02-01", value: 1100, currency: "EUR" },
    ]);

    expect(result).toMatchObject({ ok: false, error: { code: "mixed_currency" } });
  });

  it("rejects non-positive starting values and duplicate valuation dates", () => {
    expect(calculateTimeWeightedReturn([
      { date: "2026-01-01", value: 0 },
      { date: "2026-02-01", value: 10 },
    ])).toMatchObject({ ok: false, error: { code: "non_positive_start_value" } });

    expect(calculateTimeWeightedReturn([
      { date: "2026-01-01", value: 100 },
      { date: "2026-01-01", value: 101 },
    ])).toMatchObject({ ok: false, error: { code: "invalid_date" } });
  });
});

describe("portfolio performance — money-weighted return", () => {
  it("annualizes the owner cash-flow IRR", () => {
    const result = calculateMoneyWeightedReturn(
      [
        { date: "2026-01-01", value: 1000, currency: "USD" },
        { date: "2027-01-01", value: 1210, currency: "USD" },
      ],
      [{ date: "2026-07-01", amount: 100, currency: "USD" }],
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.startValueMinor).toBe(100000);
      expect(result.value.endValueMinor).toBe(121000);
      expect(result.value.externalFlowMinor).toBe(10000);
      expect(result.value.annualizedReturn).toBeCloseTo(0.10492075, 8);
    }
  });

  it("treats withdrawals as owner inflows", () => {
    const result = calculateMoneyWeightedReturn(
      [
        { date: "2026-01-01", value: 1000 },
        { date: "2027-01-01", value: 1000 },
      ],
      [{ date: "2026-07-01", amount: -100 }],
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.externalFlowMinor).toBe(-10000);
      expect(result.value.annualizedReturn).toBeGreaterThan(0);
    }
  });

  it("rejects invalid dates in cash flows", () => {
    const result = calculateMoneyWeightedReturn(
      [
        { date: "2026-01-01", value: 1000 },
        { date: "2027-01-01", value: 1100 },
      ],
      [{ date: "not-a-date", amount: 50 }],
    );

    expect(result).toMatchObject({ ok: false, error: { code: "invalid_date" } });
  });
});

describe("portfolio performance — allocation", () => {
  it("computes allocation weights from integer minor-unit values", () => {
    const result = calculateAllocation([
      { key: "AAPL", label: "Apple", value: 300.1, currency: "USD" },
      { key: "MSFT", value: 200.2, currency: "USD" },
      { key: "CASH", value: 0.1 + 0.2, currency: "USD" },
    ]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.totalMinor).toBe(50060);
      expect(result.value.total).toBe(500.6);
      expect(result.value.slices.map((slice) => slice.key)).toEqual(["AAPL", "MSFT", "CASH"]);
      expect(result.value.slices[0].weight).toBe(0.59948062);
      expect(result.value.slices[2].valueMinor).toBe(30);
    }
  });

  it("returns zero weights for an empty or zero-value allocation", () => {
    expect(calculateAllocation([])).toMatchObject({ ok: true, value: { totalMinor: 0, slices: [] } });

    const result = calculateAllocation([{ key: "AAPL", value: -10 }]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.slices[0].weight).toBe(0);
      expect(result.value.slices[0].valueMinor).toBe(0);
    }
  });

  it("rejects mixed-currency allocation without FX", () => {
    const result = calculateAllocation([
      { key: "AAPL", value: 100, currency: "USD" },
      { key: "VOD", value: 100, currency: "GBP" },
    ]);

    expect(result).toMatchObject({ ok: false, error: { code: "mixed_currency" } });
  });
});
