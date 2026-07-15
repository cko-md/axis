import { describe, expect, it } from "vitest";
import { reconcileHoldings, type ReconcilableHolding } from "./reconcileHoldings";

function r(partial: Partial<ReconcilableHolding> & { symbol: string; source: string }): ReconcilableHolding {
  return { cost_basis: 0, currency: "USD", ...partial };
}

describe("reconcileHoldings", () => {
  it("returns null (not reconciled) for a single-source symbol", () => {
    const out = reconcileHoldings([r({ symbol: "AAPL", source: "manual", cost_basis: 100 })]);
    const aapl = out.get("AAPL")!;
    expect(aapl.state).toBeNull();
    expect(aapl.sourceTotals).toEqual([
      { source: "manual", totalMinor: 10000, total: 100, currency: "USD" },
    ]);
    expect(aapl.currency).toBe("USD");
  });

  it("matches two sources with equal summed cost basis (cent-exact)", () => {
    const out = reconcileHoldings([
      r({ symbol: "MSFT", source: "manual", cost_basis: "100.10" }),
      r({ symbol: "MSFT", source: "plaid", cost_basis: 100.1 }),
    ]);
    expect(out.get("MSFT")!.state).toBe("matched");
  });

  it("flags a one-cent disagreement as conflicting (tolerance 0)", () => {
    const out = reconcileHoldings([
      r({ symbol: "TSLA", source: "manual", cost_basis: 100.0 }),
      r({ symbol: "TSLA", source: "plaid", cost_basis: 100.01 }),
    ]);
    expect(out.get("TSLA")!.state).toBe("conflicting");
  });

  it("sums multiple rows within the same source before comparing (no float drift)", () => {
    const out = reconcileHoldings([
      r({ symbol: "VOO", source: "manual", cost_basis: 0.1 }),
      r({ symbol: "VOO", source: "manual", cost_basis: 0.2 }),
      r({ symbol: "VOO", source: "plaid", cost_basis: 0.3 }),
    ]);
    const voo = out.get("VOO")!;
    expect(voo.state).toBe("matched");
    const manual = voo.sourceTotals.find((s) => s.source === "manual")!;
    expect(manual.totalMinor).toBe(30);
    expect(manual.total).toBe(0.3);
  });

  it("marks conflicting when any of three sources disagrees", () => {
    const out = reconcileHoldings([
      r({ symbol: "NVDA", source: "manual", cost_basis: 500 }),
      r({ symbol: "NVDA", source: "plaid", cost_basis: 500 }),
      r({ symbol: "NVDA", source: "public", cost_basis: 501 }),
    ]);
    expect(out.get("NVDA")!.state).toBe("conflicting");
  });

  it("does not compare across currencies — reports pending", () => {
    const out = reconcileHoldings([
      r({ symbol: "SHEL", source: "manual", cost_basis: 100, currency: "USD" }),
      r({ symbol: "SHEL", source: "plaid", cost_basis: 100, currency: "GBP" }),
    ]);
    const shel = out.get("SHEL")!;
    expect(shel.state).toBe("pending");
    expect(shel.currency).toBeNull();
  });

  it("treats a single source split across currencies as pending too", () => {
    const out = reconcileHoldings([
      r({ symbol: "BP", source: "manual", cost_basis: 100, currency: "USD" }),
      r({ symbol: "BP", source: "manual", cost_basis: 100, currency: "GBP" }),
      r({ symbol: "BP", source: "plaid", cost_basis: 200, currency: "USD" }),
    ]);
    expect(out.get("BP")!.state).toBe("pending");
  });

  it("defaults a missing/blank currency to USD and still reconciles", () => {
    const out = reconcileHoldings([
      { symbol: "AMZN", source: "manual", cost_basis: 100 },
      { symbol: "AMZN", source: "plaid", cost_basis: 100, currency: "" },
    ]);
    const amzn = out.get("AMZN")!;
    expect(amzn.state).toBe("matched");
    expect(amzn.currency).toBe("USD");
  });

  it("normalizes currency case before comparing", () => {
    const out = reconcileHoldings([
      r({ symbol: "GOOG", source: "manual", cost_basis: 100, currency: "usd" }),
      r({ symbol: "GOOG", source: "plaid", cost_basis: 100, currency: "USD" }),
    ]);
    expect(out.get("GOOG")!.state).toBe("matched");
  });

  it("handles an empty input", () => {
    expect(reconcileHoldings([]).size).toBe(0);
  });

  it("preserves first-seen symbol order deterministically", () => {
    const out = reconcileHoldings([
      r({ symbol: "B", source: "manual", cost_basis: 1 }),
      r({ symbol: "A", source: "manual", cost_basis: 1 }),
    ]);
    expect([...out.keys()]).toEqual(["B", "A"]);
  });
});
