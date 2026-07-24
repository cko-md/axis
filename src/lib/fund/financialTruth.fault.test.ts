import { describe, expect, it } from "vitest";
import {
  completeProviderSnapshot,
  addMinorUnits,
  financialInput,
  financialInputMinor,
  minorUnitsToDecimalString,
  multiplyScaledQuantityByDecimalPrice,
  multiplyScaledMinorUnits,
  strictMinorUnits,
  strictScaledUnits,
  type FinancialInput,
} from "./financialTruth";

function providerInput(amountMinor: number, currency = "USD"): FinancialInput {
  return {
    status: "fresh",
    authority: "provider",
    currency,
    amountMinor,
  };
}

describe("financial truth fault boundaries", () => {
  it("keeps unavailable and malformed inputs distinct from an explicit zero", () => {
    for (const value of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, "", "not-money", {}]) {
      expect(strictMinorUnits(value, "USD")).toBeNull();
    }

    expect(financialInput(0, { authority: "provider", currency: "USD" })).toEqual({
      status: "fresh",
      authority: "provider",
      currency: "USD",
      amountMinor: 0,
    });
    expect(financialInput(null, { authority: "provider", currency: "USD" })).toMatchObject({
      status: "error",
      amountMinor: null,
      reason: "invalid_amount",
    });
  });

  it("rounds exact decimal text half away from zero without binary-float drift", () => {
    expect(strictScaledUnits("1.005", 100)).toBe(101);
    expect(strictScaledUnits("-1.005", 100)).toBe(-101);
    expect(strictScaledUnits("0.0000005", 1_000_000)).toBe(1);
    expect(strictScaledUnits("-0.0000005", 1_000_000)).toBe(-1);
    expect(strictScaledUnits(5e-7, 1_000_000)).toBe(1);
  });

  it("uses the declared currency exponent and rejects unsafe scaled values", () => {
    expect(strictMinorUnits("1234.5", "JPY")).toBe(1235);
    expect(strictMinorUnits("1.2345", "BHD")).toBe(1235);
    expect(strictMinorUnits("42.505", "USD")).toBe(4251);
    expect(strictMinorUnits("9007199254740992", "USD")).toBeNull();
    expect(strictMinorUnits("1.00", "USX")).toBeNull();
    expect(financialInput("1", { authority: "provider", currency: "USX" })).toMatchObject({
      status: "error",
      reason: "invalid_currency",
    });
    expect(financialInput("1", {
      authority: "provider",
      currency: undefined as unknown as string,
    })).toMatchObject({
      status: "error",
      currency: "",
      amountMinor: null,
      reason: "invalid_currency",
    });
  });

  it("keeps exact minor units exact across arithmetic and persistence boundaries", () => {
    expect(addMinorUnits(Number.MAX_SAFE_INTEGER, 2, -2)).toBe(Number.MAX_SAFE_INTEGER);
    expect(multiplyScaledMinorUnits(1_005_000, 1_000, 1_000_000)).toBe(1_005);
    expect(minorUnitsToDecimalString(10_005, "USD")).toBe("100.05");
    expect(minorUnitsToDecimalString(-5, "USD")).toBe("-0.05");
    expect(financialInputMinor(10_005, { authority: "provider", currency: "USD" })).toMatchObject({
      status: "fresh",
      amountMinor: 10_005,
    });
  });

  it("multiplies decimal quotes before rounding once at the currency boundary", () => {
    expect(multiplyScaledQuantityByDecimalPrice(500_000, "1.005", 1_000_000, "USD")).toBe(50);
    expect(multiplyScaledQuantityByDecimalPrice(1_500_000, "1.005", 1_000_000, "USD")).toBe(151);
  });

  it("rejects provider balances with significant precision below the currency unit", () => {
    expect(financialInput("10.001", { authority: "provider", currency: "USD" })).toMatchObject({
      status: "error",
      amountMinor: null,
      reason: "invalid_amount",
    });
    expect(financialInput("10.000", { authority: "provider", currency: "USD" })).toMatchObject({
      status: "fresh",
      amountMinor: 1_000,
    });
  });

  it("does not retain a numeric amount for stale, missing, or errored inputs", () => {
    for (const status of ["stale", "missing", "error"] as const) {
      expect(financialInput(99, {
        status,
        authority: status === "stale" ? "stale" : "provider",
        currency: "USD",
        reason: `test_${status}`,
      })).toMatchObject({
        status,
        amountMinor: null,
        reason: `test_${status}`,
      });
    }
  });

  it("refuses to launder manual or estimated values into provider truth", () => {
    for (const authority of ["manual", "estimated", "stale"] as const) {
      const outcome = completeProviderSnapshot({
        cash: providerInput(10_000),
        invested: { ...providerInput(20_000), authority },
        liabilities: providerInput(5_000),
      });

      expect(outcome).toMatchObject({
        status: "error",
        authority,
        reason: "non_provider_authority_cannot_form_provider_snapshot",
      });
    }
  });

  it("declines incomplete and mixed-currency snapshots instead of fabricating zero or FX", () => {
    const missing = completeProviderSnapshot({
      cash: {
        status: "missing",
        authority: "provider",
        currency: "USD",
        amountMinor: null,
        reason: "cash_missing",
      },
      invested: providerInput(20_000),
      liabilities: providerInput(5_000),
    });
    expect(missing).toMatchObject({
      status: "missing",
      reason: "cash_missing",
    });

    const mixed = completeProviderSnapshot({
      cash: providerInput(10_000, "USD"),
      invested: providerInput(20_000, "EUR"),
      liabilities: providerInput(5_000, "USD"),
    });
    expect(mixed).toMatchObject({
      status: "error",
      reason: "mixed_currency_without_fx",
    });

    expect(completeProviderSnapshot({
      cash: providerInput(-100),
      invested: providerInput(-1),
      liabilities: providerInput(0),
    })).toMatchObject({ status: "error", reason: "negative_invested_balance" });
    expect(completeProviderSnapshot({
      cash: providerInput(-100),
      invested: providerInput(0),
      liabilities: providerInput(-1),
    })).toMatchObject({ status: "error", reason: "negative_liability_balance" });
  });

  it("rejects aggregate overflow even when every component is individually safe", () => {
    const outcome = completeProviderSnapshot({
      cash: providerInput(Number.MAX_SAFE_INTEGER),
      invested: providerInput(Number.MAX_SAFE_INTEGER),
      liabilities: providerInput(0),
    });

    expect(outcome).toMatchObject({
      status: "error",
      reason: "net_worth_out_of_range",
    });
  });

  it("does not lose a cent when an unsafe intermediate cancels to a safe final value", () => {
    expect(completeProviderSnapshot({
      cash: providerInput(Number.MAX_SAFE_INTEGER),
      invested: providerInput(2),
      liabilities: providerInput(2),
    })).toMatchObject({
      status: "fresh",
      netWorthMinor: Number.MAX_SAFE_INTEGER,
    });
  });

  it("computes a complete provider snapshot only from exact minor units", () => {
    expect(completeProviderSnapshot({
      cash: providerInput(10_001),
      invested: providerInput(20_002),
      liabilities: providerInput(5_003),
    })).toEqual({
      status: "fresh",
      authority: "provider",
      currency: "USD",
      cashMinor: 10_001,
      investedMinor: 20_002,
      liabilitiesMinor: 5_003,
      netWorthMinor: 25_000,
    });
  });
});
