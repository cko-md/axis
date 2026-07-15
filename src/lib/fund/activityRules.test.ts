import { describe, expect, it } from "vitest";
import {
  assessActivityAnomaly,
  categorizeProviderActivity,
  normalizeActivityMerchantKey,
  resolveActivityCategory,
} from "./activityRules";

describe("activity categorization", () => {
  it("uses a stable provider taxonomy and maps unknown labels to OTHER", () => {
    expect(categorizeProviderActivity("food and beverage")).toBe("FOOD_AND_DRINK");
    expect(categorizeProviderActivity("home-improvement")).toBe("GENERAL_MERCHANDISE");
    expect(categorizeProviderActivity("loan payments")).toBe("OTHER");
  });

  it("keeps a manual category authoritative", () => {
    expect(resolveActivityCategory({ customCategory: "travel", providerCategory: "groceries" })).toEqual({
      category: "TRAVEL",
      source: "manual",
    });
    expect(resolveActivityCategory({ customCategory: "pet care", providerCategory: "groceries" })).toEqual({
      category: "PET_CARE",
      source: "manual",
    });
  });
});

describe("activity anomaly rules", () => {
  it("normalizes merchant labels only for comparison", () => {
    expect(normalizeActivityMerchantKey("  ACME, Inc. #123 ")).toBe("ACME INC 123");
  });

  it("flags a high-value first merchant with cent-exact minor-unit math", () => {
    const assessment = assessActivityAnomaly({ id: "today", merchantName: "Acme", amount: -200.01 }, []);
    expect(assessment).toMatchObject({
      flagged: true,
      reason: "new_merchant_high_amount",
      amountMinor: 20_001,
      sampleCount: 0,
    });
  });

  it("does not imply a USD threshold applies to an unconverted currency", () => {
    expect(assessActivityAnomaly({ id: "today", merchantName: "Acme", amount: -200.01, currency: "EUR" }, []).flagged).toBe(false);
  });

  it("requires a strict over-2x same-currency merchant baseline", () => {
    const history = [
      { id: "a", merchantName: "Acme Market", amount: -10, currency: "USD" },
      { id: "b", merchantName: "ACME MARKET", amount: -20, currency: "USD" },
      { id: "c", merchantName: "Acme Market", amount: -1000, currency: "EUR" },
    ];
    expect(assessActivityAnomaly({ id: "today", merchantName: "Acme Market", amount: -30, currency: "USD" }, history)).toMatchObject({
      flagged: false,
      sampleCount: 2,
      baselineAverageMinor: 1500,
    });
    expect(assessActivityAnomaly({ id: "today", merchantName: "Acme Market", amount: -30.01, currency: "USD" }, history)).toMatchObject({
      flagged: true,
      reason: "merchant_amount_outlier",
    });
  });

  it("never flags transfers, pending entries, inflows, or a non-merchant amount", () => {
    const history = [{ id: "a", merchantName: "Acme", amount: -1000 }];
    expect(assessActivityAnomaly({ id: "today", merchantName: "Acme", amount: -100_000, isTransfer: true }, history).flagged).toBe(false);
    expect(assessActivityAnomaly({ id: "today", merchantName: "Acme", amount: -100_000, pending: true }, history).flagged).toBe(false);
    expect(assessActivityAnomaly({ id: "today", merchantName: "Acme", amount: 100_000 }, history).flagged).toBe(false);
    expect(assessActivityAnomaly({ id: "today", merchantName: null, amount: -100_000 }, history).flagged).toBe(false);
  });
});
