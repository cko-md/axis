import { describe, expect, it } from "vitest";
import { parseMoney, sumBy, sumMoney, toMajorUnits, toMinorUnits } from "./money";

describe("fund money — deterministic minor-unit conversion", () => {
  it("parses numeric and string amounts to integer cents", () => {
    expect(toMinorUnits(42.5)).toBe(4250);
    expect(toMinorUnits("42.50")).toBe(4250);
    expect(toMinorUnits(0)).toBe(0);
    expect(toMinorUnits("0.01")).toBe(1);
  });

  it("tolerates currency symbols and thousands separators", () => {
    expect(toMinorUnits("$1,299.99")).toBe(129999);
    expect(toMinorUnits(" 1 234.56 ")).toBe(123456);
  });

  it("rounds to the nearest cent, half away from zero", () => {
    expect(toMinorUnits(42.505)).toBe(4251);
    expect(toMinorUnits(42.504)).toBe(4250);
    expect(toMinorUnits(-2.005)).toBe(-201);
  });

  it("normalizes invalid / non-finite input to zero (matches safeMoney contract)", () => {
    expect(toMinorUnits("not money")).toBe(0);
    expect(toMinorUnits("")).toBe(0);
    expect(toMinorUnits(Number.POSITIVE_INFINITY)).toBe(0);
    expect(toMinorUnits(Number.NaN)).toBe(0);
    expect(toMinorUnits(null)).toBe(0);
    expect(toMinorUnits(undefined)).toBe(0);
  });

  it("round-trips minor <-> major units", () => {
    expect(toMajorUnits(4250)).toBe(42.5);
    expect(toMajorUnits(1)).toBe(0.01);
    expect(parseMoney("42.505")).toBe(42.51);
    expect(parseMoney("garbage")).toBe(0);
  });
});

describe("fund money — financial invariants (no float drift)", () => {
  it("sums 0.1 + 0.2 to exactly 0.3", () => {
    // The canonical IEEE-754 failure: 0.1 + 0.2 === 0.30000000000000004.
    expect(0.1 + 0.2).not.toBe(0.3); // guard: the hazard is real
    expect(sumMoney([0.1, 0.2])).toBe(0.3);
  });

  it("does not accumulate rounding error over a large roll-up", () => {
    const amounts = Array.from({ length: 1000 }, () => 0.1);
    // Naive float reduce drifts away from the exact total.
    const naive = amounts.reduce((s, a) => s + a, 0);
    expect(naive).not.toBe(100);
    expect(sumMoney(amounts)).toBe(100);
  });

  it("is order-independent", () => {
    const a = [0.1, 0.2, 0.3, 100.05, -0.55];
    const reversed = [...a].reverse();
    expect(sumMoney(a)).toBe(sumMoney(reversed));
  });

  it("handles mixed string/number provider payloads and negatives", () => {
    expect(sumMoney(["100.00", -25.5, "12.34", "not money"])).toBe(86.84);
  });

  it("sumBy projects a field before summing (reduce+Number replacement)", () => {
    const liabilities = [{ balance: "1000.10" }, { balance: 2000.2 }, { balance: null }];
    expect(sumBy(liabilities, (l) => l.balance)).toBe(3000.3);
  });

  it("sumMoney of an empty list is 0", () => {
    expect(sumMoney([])).toBe(0);
  });
});
