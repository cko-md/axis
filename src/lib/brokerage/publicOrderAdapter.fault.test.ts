import { describe, expect, it } from "vitest";
import { preparePublicOrder } from "./publicOrderAdapter";

describe("public order adapter exact representation faults", () => {
  it("rejects a limit price that cannot round-trip through compatibility number fields", () => {
    const result = preparePublicOrder({
      symbol: "BRK.A",
      side: "buy",
      quantity: "1",
      type: "limit",
      limitPrice: "90071992547409.91",
      currency: "USD",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("exact numeric compatibility range");
  });

  it("rejects a quantity that would render with one-microshare drift", () => {
    const result = preparePublicOrder({
      symbol: "AAPL",
      side: "sell",
      quantity: "9007199254.740991",
      currency: "USD",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("exact numeric compatibility range");
  });

  it("rejects a notional whose compatibility number would lose one cent", () => {
    const result = preparePublicOrder({
      symbol: "BRK.A",
      side: "buy",
      quantity: "2",
      type: "limit",
      limitPrice: "45035996272704.98",
      currency: "USD",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("estimated notional is outside the exact numeric compatibility range");
  });
});
