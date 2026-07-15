import { describe, expect, it } from "vitest";
import { breachObjective, reviewConcentration } from "./concentrationReview";

describe("reviewConcentration", () => {
  it("computes exact weights that sum to ~1", () => {
    const r = reviewConcentration([
      { symbol: "AAPL", value: 25 },
      { symbol: "MSFT", value: 25 },
      { symbol: "NVDA", value: 50 },
    ]);
    expect(r.total).toBe(100);
    expect(r.positions[0].symbol).toBe("NVDA");
    expect(r.positions[0].weight).toBe(0.5);
    const sum = r.positions.reduce((s, p) => s + p.weight, 0);
    expect(Math.abs(sum - 1)).toBeLessThan(0.0002);
  });

  it("flags only positions over the target and computes the trim amount", () => {
    const r = reviewConcentration(
      [
        { symbol: "NVDA", value: 60 },
        { symbol: "AAPL", value: 40 },
      ],
      0.25,
    );
    expect(r.breaches.map((b) => b.symbol)).toEqual(["NVDA", "AAPL"]);
    const nvda = r.breaches.find((b) => b.symbol === "NVDA")!;
    // target value at 25% of 100 = 25; over by 60 - 25 = 35.
    expect(nvda.overByValue).toBe(35);
  });

  it("returns no breaches when everything is under the cap", () => {
    const r = reviewConcentration(
      [
        { symbol: "A", value: 10 },
        { symbol: "B", value: 10 },
        { symbol: "C", value: 10 },
        { symbol: "D", value: 10 },
        { symbol: "E", value: 10 },
      ],
      0.25,
    );
    expect(r.breaches).toEqual([]);
  });

  it("handles an empty / zero portfolio without dividing by zero", () => {
    expect(reviewConcentration([]).breaches).toEqual([]);
    const z = reviewConcentration([{ symbol: "X", value: 0 }]);
    expect(z.total).toBe(0);
    expect(z.positions[0].weight).toBe(0);
    expect(z.breaches).toEqual([]);
  });

  it("ignores negative values (never negative weights)", () => {
    const r = reviewConcentration([
      { symbol: "GOOD", value: 100 },
      { symbol: "BAD", value: -50 },
    ]);
    expect(r.positions.every((p) => p.weight >= 0)).toBe(true);
  });

  it("breachObjective is stable for a given breach (idempotency key)", () => {
    const [breach] = reviewConcentration([{ symbol: "NVDA", value: 100 }], 0.25).breaches;
    const a = breachObjective(breach, 0.25);
    const b = breachObjective(breach, 0.25);
    expect(a).toBe(b);
    expect(a).toContain("NVDA");
    expect(a).toContain("100.0%");
  });
});
