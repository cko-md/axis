import { describe, expect, it } from "vitest";
import { buildOrderTicket, describeOrderTicket } from "./orderTicket";

describe("buildOrderTicket", () => {
  it("builds a valid market buy with a cent-exact notional", () => {
    const r = buildOrderTicket({ symbol: "aapl", side: "buy", quantity: 10, referencePrice: 212.34 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ticket.symbol).toBe("AAPL");
      expect(r.ticket.type).toBe("market");
      expect(r.ticket.estimatedNotional).toBe(2123.4);
    }
  });

  it("supports fractional shares", () => {
    const r = buildOrderTicket({ symbol: "MSFT", side: "buy", quantity: 2.5, referencePrice: 400 });
    expect(r.ok && r.ticket.estimatedNotional).toBe(1000);
  });

  it("requires a positive limit price for a limit order and uses it for notional", () => {
    const bad = buildOrderTicket({ symbol: "NVDA", side: "sell", quantity: 5, type: "limit", referencePrice: 120 });
    expect(bad.ok).toBe(false);
    const good = buildOrderTicket({ symbol: "NVDA", side: "sell", quantity: 5, type: "limit", limitPrice: 130, referencePrice: 120 });
    expect(good.ok && good.ticket.estimatedNotional).toBe(650);
  });

  it("rejects non-positive quantity and bad side", () => {
    expect(buildOrderTicket({ symbol: "X", side: "buy", quantity: 0, referencePrice: 1 }).ok).toBe(false);
    // @ts-expect-error invalid side on purpose
    expect(buildOrderTicket({ symbol: "X", side: "hold", quantity: 1, referencePrice: 1 }).ok).toBe(false);
  });

  it("collects multiple errors", () => {
    const r = buildOrderTicket({ symbol: "", side: "buy", quantity: -1, referencePrice: -5 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThanOrEqual(3);
  });

  it("describes a ticket in one line", () => {
    const r = buildOrderTicket({ symbol: "AAPL", side: "buy", quantity: 10, referencePrice: 212 });
    expect(r.ok && describeOrderTicket(r.ticket)).toBe("Buy 10 AAPL (market)");
  });
});
