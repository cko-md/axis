import { describe, expect, it } from "vitest";
import {
  shapeRecurringForFinancialNarration,
  strictNarrationMoney,
} from "./financeNarratorContext";

describe("exact financial narration context", () => {
  it("preserves exact money or marks invalid input unavailable", () => {
    expect(strictNarrationMoney("42.50")).toEqual({ amount: "42.50", amountMinor: 4_250 });
    expect(strictNarrationMoney("not money")).toBeNull();
    expect(strictNarrationMoney(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("does not turn an invalid recurring amount into numeric zero", () => {
    expect(shapeRecurringForFinancialNarration([{
      merchant_name: "Merchant",
      expected_amount: "not money",
      cadence: "monthly",
      last_seen_date: "2026-07-03",
    }])[0]).toMatchObject({
      expected_amount: null,
      expected_amount_minor: null,
    });
  });
});
