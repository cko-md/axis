import { describe, expect, it } from "vitest";
import { cleanFinanceLabel, safeMoney, shapeRecurringForNarration } from "./financeNarratorContext";

describe("finance narrator context shaping", () => {
  it("cleans labels before they are sent to AI or Make", () => {
    expect(cleanFinanceLabel("  Coffee\u0000Shop\n\nDowntown  ")).toBe("Coffee Shop Downtown");
    expect(cleanFinanceLabel("", "fallback")).toBe("fallback");
    expect(cleanFinanceLabel("x".repeat(160))).toHaveLength(120);
  });

  it("normalizes invalid money values to zero", () => {
    expect(safeMoney("42.50")).toBe(42.5);
    expect(safeMoney("not money")).toBe(0);
    expect(safeMoney(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("bounds recurring charges and strips noisy merchant labels", () => {
    const shaped = shapeRecurringForNarration(
      Array.from({ length: 12 }, (_, index) => ({
        merchant_name: ` Merchant\u0000${index} `,
        expected_amount: index === 0 ? "not money" : index,
        cadence: " monthly ",
        last_seen_date: "2026-07-03T12:00:00.000Z-extra-data",
      })),
    );

    expect(shaped).toHaveLength(10);
    expect(shaped[0]).toEqual({
      merchant_name: "Merchant 0",
      expected_amount: 0,
      cadence: "monthly",
      last_seen_date: "2026-07-03T12:00:00.000Z-extra-data",
    });
  });
});
