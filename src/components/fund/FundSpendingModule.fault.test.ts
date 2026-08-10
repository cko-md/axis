import { describe, expect, it } from "vitest";
import { aggregateBudgetSpend } from "./FundSpendingModule";

function transaction(amountMinor: number) {
  return {
    id: String(amountMinor),
    merchant_name: "Merchant",
    raw_name: "Merchant",
    amount: -1,
    amount_minor: amountMinor,
    iso_currency_code: "USD",
    plaid_category: "FOOD_AND_DRINK",
    custom_category: null,
    tags: null,
    is_transfer: false,
    excluded_from_budget: false,
    reviewed: false,
    pending: false,
    posted_date: "2026-08-01",
  };
}

describe("budget spend aggregation", () => {
  it("marks an overflowing category total unavailable instead of wrapping or rendering a percentage", () => {
    const largestSafeHalf = Math.ceil(Number.MAX_SAFE_INTEGER / 2);
    const totals = aggregateBudgetSpend([
      transaction(-largestSafeHalf),
      transaction(-largestSafeHalf),
    ]);

    expect(totals.has("FOOD_AND_DRINK\u0000USD")).toBe(true);
    expect(totals.get("FOOD_AND_DRINK\u0000USD")).toBeNull();
  });
});
