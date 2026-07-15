import { describe, expect, it } from "vitest";
import {
  CURRENCY_EXPONENTS,
  CURRENCY_MINOR_UNITS,
  DEFAULT_CURRENCY_EXPONENT,
  exponentFor,
  minorUnitsFor,
  toMajorUnitsIn,
  toMinorUnitsIn,
} from "./currency";

describe("exponentFor / minorUnitsFor", () => {
  it("returns 2 (100 minor units) for the majors", () => {
    for (const code of ["USD", "EUR", "GBP", "CAD", "AUD"]) {
      expect(exponentFor(code)).toBe(2);
      expect(minorUnitsFor(code)).toBe(100);
    }
  });

  it("returns 0 for zero-decimal currencies", () => {
    for (const code of ["JPY", "KRW", "VND", "CLP", "ISK"]) {
      expect(exponentFor(code)).toBe(0);
      expect(minorUnitsFor(code)).toBe(1);
    }
  });

  it("returns 3 for three-decimal currencies", () => {
    for (const code of ["BHD", "KWD", "OMR", "JOD", "TND"]) {
      expect(exponentFor(code)).toBe(3);
      expect(minorUnitsFor(code)).toBe(1000);
    }
  });

  it("defaults unknown codes to 2", () => {
    expect(exponentFor("ZZZ")).toBe(DEFAULT_CURRENCY_EXPONENT);
    expect(minorUnitsFor("ZZZ")).toBe(100);
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(exponentFor("jpy")).toBe(0);
    expect(exponentFor("  bhd ")).toBe(3);
  });

  it("keeps the derived minor-units table consistent with the exponent table", () => {
    for (const [code, exp] of Object.entries(CURRENCY_EXPONENTS)) {
      expect(CURRENCY_MINOR_UNITS[code]).toBe(10 ** exp);
    }
  });
});

describe("toMinorUnitsIn / toMajorUnitsIn", () => {
  it("JPY has no minor unit: ¥1234 is 1234", () => {
    expect(toMinorUnitsIn(1234, "JPY")).toBe(1234);
    expect(toMajorUnitsIn(1234, "JPY")).toBe(1234);
  });

  it("BHD has 1000 fils per dinar", () => {
    expect(toMinorUnitsIn("1.234", "BHD")).toBe(1234);
    expect(toMajorUnitsIn(1234, "BHD")).toBe(1.234);
  });

  it("matches the money.ts contract for 2-decimal currencies", () => {
    expect(toMinorUnitsIn("42.50", "USD")).toBe(4250);
    expect(toMinorUnitsIn("$1,299.99", "USD")).toBe(129999);
    expect(toMajorUnitsIn(4250, "USD")).toBe(42.5);
  });

  it("rounds half away from zero at the currency's smallest unit", () => {
    expect(toMinorUnitsIn(0.5, "JPY")).toBe(1);
    expect(toMinorUnitsIn(-0.5, "JPY")).toBe(-1);
    expect(toMinorUnitsIn(1.0005, "BHD")).toBe(1001);
    expect(toMinorUnitsIn(42.505, "USD")).toBe(4251);
  });

  it("returns 0 for invalid / non-finite input", () => {
    expect(toMinorUnitsIn("not money", "JPY")).toBe(0);
    expect(toMinorUnitsIn(Infinity, "USD")).toBe(0);
    expect(toMinorUnitsIn(undefined, "BHD")).toBe(0);
    expect(toMajorUnitsIn(Number.NaN, "USD")).toBe(0);
  });

  it("round-trips exact minor amounts", () => {
    for (const [amount, code] of [
      [123456, "USD"],
      [123456, "JPY"],
      [123456, "BHD"],
    ] as const) {
      expect(toMinorUnitsIn(toMajorUnitsIn(amount, code), code)).toBe(amount);
    }
  });
});
