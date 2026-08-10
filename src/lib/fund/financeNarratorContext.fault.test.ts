import { describe, expect, it } from "vitest";
import {
  shapeRecurringForFinancialNarration,
  strictNarrationMoney,
} from "./financeNarratorContext";

describe("exact financial narration context", () => {
  it("preserves exact money or marks invalid input unavailable", () => {
    expect(strictNarrationMoney("42.50")).toEqual({ amount: "42.50", amountMinor: 4_250, currency: "USD" });
    expect(strictNarrationMoney("100", "JPY")).toEqual({ amount: "100", amountMinor: 100, currency: "JPY" });
    expect(strictNarrationMoney("1.234", "BHD")).toEqual({ amount: "1.234", amountMinor: 1_234, currency: "BHD" });
    expect(strictNarrationMoney("1.2345", "BHD")).toBeNull();
    expect(strictNarrationMoney("42.50", "USX")).toBeNull();
    expect(strictNarrationMoney("not money")).toBeNull();
    expect(strictNarrationMoney(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("does not turn an invalid recurring amount into numeric zero", () => {
    expect(shapeRecurringForFinancialNarration([{
      merchant_name: "Merchant",
      expected_amount: "not money",
      currency: "USD",
      cadence: "monthly",
      last_seen_date: "2026-07-03",
    }])[0]).toMatchObject({
      expected_amount: null,
      expected_amount_minor: null,
      currency: null,
    });
  });

  it("keeps each recurring amount bound to its validated currency", () => {
    expect(shapeRecurringForFinancialNarration([{
      merchant_name: "Tokyo rent",
      expected_amount: "100",
      currency: "JPY",
      cadence: "monthly",
      last_seen_date: "2026-07-03",
    }])[0]).toMatchObject({
      expected_amount: "100",
      expected_amount_minor: 100,
      currency: "JPY",
    });
  });
});
