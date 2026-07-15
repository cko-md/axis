import { describe, expect, it } from "vitest";
import { proposeRebalance } from "./rebalanceProposal";

describe("proposeRebalance", () => {
  it("proposes buys and sells to reach target weights", () => {
    // Portfolio $10k: AAPL 70% ($7k), MSFT 30% ($3k). Target 50/50.
    const p = proposeRebalance({
      positions: [{ symbol: "AAPL", value: 7000 }, { symbol: "MSFT", value: 3000 }],
      targets: { AAPL: 0.5, MSFT: 0.5 },
      prices: { AAPL: 200, MSFT: 100 },
    });
    expect(p.total).toBe(10000);
    const aapl = p.actions.find((a) => a.symbol === "AAPL")!;
    const msft = p.actions.find((a) => a.symbol === "MSFT")!;
    expect(aapl.side).toBe("sell"); // 70% -> 50%, trim $2000
    expect(aapl.tradeValue).toBe(2000);
    expect(aapl.ticket.quantity).toBe(10); // 2000 / 200
    expect(msft.side).toBe("buy"); // 30% -> 50%, add $2000
    expect(msft.ticket.quantity).toBe(20); // 2000 / 100
  });

  it("skips positions within the drift threshold", () => {
    const p = proposeRebalance({
      positions: [{ symbol: "A", value: 5100 }, { symbol: "B", value: 4900 }],
      targets: { A: 0.5, B: 0.5 },
      prices: { A: 10, B: 10 },
    });
    // 51% vs 50% is within the default 5-point drift.
    expect(p.actions).toEqual([]);
  });

  it("sells a position entirely when its target is 0", () => {
    const p = proposeRebalance({
      positions: [{ symbol: "OLD", value: 2000 }, { symbol: "KEEP", value: 8000 }],
      targets: { KEEP: 1 },
      prices: { OLD: 40, KEEP: 80 },
    });
    const old = p.actions.find((a) => a.symbol === "OLD")!;
    expect(old.side).toBe("sell");
    expect(old.tradeValue).toBe(2000);
  });

  it("skips a drifted symbol with no price", () => {
    const p = proposeRebalance({
      positions: [{ symbol: "A", value: 8000 }, { symbol: "B", value: 2000 }],
      targets: { A: 0.5, B: 0.5 },
      prices: { A: 100 }, // B has no price
    });
    expect(p.skipped).toContain("B");
    expect(p.actions.every((a) => a.symbol !== "B")).toBe(true);
  });

  it("returns nothing for an empty portfolio", () => {
    expect(proposeRebalance({ positions: [], targets: { A: 1 }, prices: { A: 10 } }).actions).toEqual([]);
  });
});
