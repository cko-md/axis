import { describe, expect, it } from "vitest";
import { preparePublicOrder, submitPublicOrder, verifyPublicOrder } from "./publicOrderAdapter";

describe("public order adapter", () => {
  it("prepares a financial execution draft without enabling submit", () => {
    const result = preparePublicOrder({
      symbol: "aapl",
      side: "buy",
      quantity: 2,
      referencePrice: 195.12,
      currency: "USD",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.symbol).toBe("AAPL");
    expect(result.data.actionClass).toBe("FINANCIAL_EXECUTION");
    expect(result.data.requiresApproval).toBe(true);
    expect(result.data.submitEnabled).toBe(false);
    expect(result.data.estimatedNotional).toBe(390.24);
    expect(result.data.summary).toBe("Buy 2 AAPL (market)");
  });

  it("keeps notional honest when no quote/reference price is supplied", () => {
    const result = preparePublicOrder({ symbol: "msft", side: "sell", quantity: "1.5", currency: "USD" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.estimatedNotional).toBeNull();
    expect(result.data.ticket).toBeNull();
    expect(result.data.warnings).toContain("referencePrice missing; estimated notional is unavailable until quote verification");
  });

  it("binds limit-order notional to the limit price rather than the reference quote", () => {
    const result = preparePublicOrder({
      symbol: "nvda",
      side: "buy",
      quantity: "5",
      type: "limit",
      limitPrice: "130.00",
      referencePrice: "120.00",
      currency: "USD",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.estimatedNotionalMinor).toBe(65_000);
    expect(result.data.estimatedNotional).toBe(650);
    expect(result.data.ticket?.estimatedNotionalMinor).toBe(65_000);
  });

  it("derives a limit-order notional without an optional reference quote", () => {
    const result = preparePublicOrder({
      symbol: "nvda",
      side: "buy",
      quantity: "5",
      type: "limit",
      limitPrice: "130.00",
      currency: "USD",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.referencePriceMinor).toBeNull();
    expect(result.data.estimatedNotionalMinor).toBe(65_000);
    expect(result.data.ticket).toMatchObject({
      referencePrice: null,
      estimatedNotionalMinor: 65_000,
    });
  });

  it.each(["1.0000004", "1.0000005", "1.0000009", "0.0000005"])(
    "rejects quantity %s instead of rounding immutable intent units",
    (quantity) => {
      const result = preparePublicOrder({
        symbol: "AAPL",
        side: "buy",
        quantity,
        referencePrice: "100.00",
        currency: "USD",
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("at most 6 decimal places");
    },
  );

  it("rejects malformed order requests structurally", () => {
    const result = preparePublicOrder({ symbol: "", side: "hold", quantity: 0 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_request");
    expect(result.error.retryable).toBe(false);
  });

  it("verifies configuration state without making an order actionable", () => {
    const result = verifyPublicOrder(
      { symbol: "VOO", side: "buy", quantity: 1, referencePrice: 500, currency: "USD" },
      { brokerageConfigured: true, accountConfigured: true },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.brokerageConfigured).toBe(true);
    expect(result.data.approvalRequired).toBe(true);
    expect(result.data.stepUpRequired).toBe(true);
    expect(result.data.submitEnabled).toBe(false);
  });

  it("refuses submit without server-verified approval clearance", () => {
    const result = submitPublicOrder({ symbol: "AAPL", side: "buy", quantity: 1, currency: "USD" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_request");
    expect(result.error.message).toContain("Server-verified approval");
  });

  it("still refuses live submit even after a verified clearance placeholder", () => {
    const result = submitPublicOrder(
      { symbol: "AAPL", side: "buy", quantity: 1, currency: "USD" },
      { approvalId: "approval-1", serverVerified: true },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("not_supported");
    expect(result.error.retryable).toBe(false);
  });
});
