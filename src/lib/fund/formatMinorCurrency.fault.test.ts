import { describe, expect, it } from "vitest";
import { formatSignedMinorCurrency } from "./formatMinorCurrency";

describe("currency-true transaction display", () => {
  it.each([
    [12_345, "USD", "+$123.45"],
    [-12_345, "EUR", "−€123.45"],
    [1_234, "JPY", "+¥1,234"],
    [-1_234, "BHD", "−BHD\u00a01.234"],
  ] as const)("formats %s minor %s without assuming cents", (minor, currency, expected) => {
    expect(formatSignedMinorCurrency(minor, currency)).toBe(expected);
  });

  it("withholds malformed currency inputs", () => {
    expect(formatSignedMinorCurrency(100, "USX")).toBeNull();
    expect(formatSignedMinorCurrency(1.5, "USD")).toBeNull();
  });

  it.each([
    [Number.MAX_SAFE_INTEGER, "USD", "+$90,071,992,547,409.91"],
    [Number.MAX_SAFE_INTEGER, "BHD", "+BHD\u00a09,007,199,254,740.991"],
  ] as const)("preserves every minor unit at the safe-integer boundary for %s %s", (minor, currency, expected) => {
    expect(formatSignedMinorCurrency(minor, currency)).toBe(expected);
  });
});
