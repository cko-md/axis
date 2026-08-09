import { describe, expect, it } from "vitest";
import { buildOrderTicket } from "./orderTicket";

describe("order ticket exact intent boundaries", () => {
  it("builds a limit ticket from its limit price without a reference quote", () => {
    const result = buildOrderTicket({
      symbol: "NVDA",
      side: "buy",
      quantity: 5,
      type: "limit",
      limitPrice: 130,
      currency: "USD",
    });

    expect(result).toMatchObject({
      ok: true,
      ticket: {
        referencePrice: null,
        estimatedNotionalMinor: 65_000,
      },
    });
  });

  it("rejects quantity precision that cannot be represented exactly", () => {
    expect(buildOrderTicket({
      symbol: "AAPL",
      side: "buy",
      quantity: 1.0000005,
      referencePrice: 100,
      currency: "USD",
    })).toMatchObject({ ok: false });
  });

  it("rejects contradictory compatibility and exact aliases", () => {
    expect(buildOrderTicket({
      symbol: "AAPL",
      side: "buy",
      quantity: 1,
      quantityUnits: 2_000_000,
      quantityScale: 1_000_000,
      referencePrice: 100,
      referencePriceMinor: 10_000,
      currency: "USD",
    })).toMatchObject({ ok: false, errors: expect.arrayContaining(["quantity and quantityUnits disagree"]) });

    expect(buildOrderTicket({
      symbol: "AAPL",
      side: "buy",
      quantity: 1,
      quantityUnits: 1_000_000,
      quantityScale: 1_000_000,
      type: "limit",
      limitPrice: 100,
      limitPriceMinor: 1,
      currency: "USD",
    })).toMatchObject({ ok: false, errors: expect.arrayContaining(["limitPrice and limitPriceMinor disagree"]) });
  });
});
