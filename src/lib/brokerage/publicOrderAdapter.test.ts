import { describe, expect, it } from "vitest";
import { preparePublicOrder, submitPublicOrder, verifyPublicOrder } from "./publicOrderAdapter";

describe("public order adapter", () => {
  it("prepares a financial execution draft without enabling submit", () => {
    const result = preparePublicOrder({
      symbol: "aapl",
      side: "buy",
      quantity: 2,
      referencePrice: 195.12,
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
    const result = preparePublicOrder({ symbol: "msft", side: "sell", quantity: "1.5" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.estimatedNotional).toBeNull();
    expect(result.data.ticket).toBeNull();
    expect(result.data.warnings).toContain("referencePrice missing; estimated notional is unavailable until quote verification");
  });

  it("rejects malformed order requests structurally", () => {
    const result = preparePublicOrder({ symbol: "", side: "hold", quantity: 0 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_request");
    expect(result.error.retryable).toBe(false);
  });

  it("verifies configuration state without making an order actionable", () => {
    const result = verifyPublicOrder(
      { symbol: "VOO", side: "buy", quantity: 1, referencePrice: 500 },
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
    const result = submitPublicOrder({ symbol: "AAPL", side: "buy", quantity: 1 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_request");
    expect(result.error.message).toContain("Server-verified approval");
  });

  it("still refuses live submit even after a verified clearance placeholder", () => {
    const result = submitPublicOrder(
      { symbol: "AAPL", side: "buy", quantity: 1 },
      { approvalId: "approval-1", serverVerified: true },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("not_supported");
    expect(result.error.retryable).toBe(false);
  });
});
