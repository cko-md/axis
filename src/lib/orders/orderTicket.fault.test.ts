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

  it("uses exact scaled quantity and minor price fields at high-value boundaries", () => {
    const result = buildOrderTicket({
      symbol: "BRK.A",
      side: "buy",
      quantity: 1,
      quantityUnits: 1_000_000,
      quantityScale: 1_000_000,
      type: "limit",
      limitPrice: 90_071_992_547_409.9,
      limitPriceMinor: Number.MAX_SAFE_INTEGER,
      currency: "USD",
    });

    expect(result).toMatchObject({
      ok: true,
      ticket: {
        quantityText: "1.000000",
        limitPriceText: "90071992547409.91",
        estimatedNotionalMinor: Number.MAX_SAFE_INTEGER,
        estimatedNotionalText: "90071992547409.91",
      },
    });
  });
});
