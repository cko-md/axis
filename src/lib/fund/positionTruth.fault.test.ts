import { describe, expect, it, vi } from "vitest";
import {
  calculateLivePosition,
  fetchPortfolioQuotes,
  quoteIsAuthoritative,
  validateHoldingCoverage,
  type PositionHoldingInput,
  type PositionQuoteInput,
} from "./positionTruth";

const holdings: PositionHoldingInput[] = [
  { symbol: "AAPL", shares: "1.005", cost_basis: "8.00", currency: "USD" },
  { symbol: "MSFT", shares: "2", cost_basis: "30.00", currency: "USD" },
];

function quotes(entries: Array<[string, PositionQuoteInput]>) {
  const now = new Date().toISOString();
  return new Map<string, PositionQuoteInput>(entries.map(([symbol, quote]) => [
    symbol,
    quote ? {
      ...quote,
      source: "massive",
      asOf: now,
      observedAt: now,
      snapshotUpdatedAt: now,
      marketSession: "open",
    } : null,
  ]));
}

describe("live position financial-truth faults", () => {
  const now = Date.parse("2026-08-09T20:00:00.000Z");

  it("requires a fresh provider event during an open market session", () => {
    expect(quoteIsAuthoritative({
      price: "100.00",
      chg: 1,
      source: "massive",
      asOf: "2026-08-09T19:59:00.000Z",
      observedAt: "2026-08-09T20:00:00.000Z",
      snapshotUpdatedAt: "2026-08-09T19:59:30.000Z",
      marketSession: "open",
    }, now)).toBe(true);
    expect(quoteIsAuthoritative({
      price: "100.00",
      chg: 1,
      source: "massive",
      asOf: "2026-08-09T19:00:00.000Z",
      observedAt: "2026-08-09T20:00:00.000Z",
      snapshotUpdatedAt: "2026-08-09T19:59:30.000Z",
      marketSession: "open",
    }, now)).toBe(false);
  });

  it("accepts only a recent latest-completed-session bar while the market is closed", () => {
    const closed = {
      price: "100.00",
      chg: 1,
      source: "massive",
      observedAt: "2026-08-09T20:00:00.000Z",
      snapshotUpdatedAt: "2026-08-09T19:59:00.000Z",
      marketSession: "closed",
      latestCompletedSession: true,
    } as const;
    expect(quoteIsAuthoritative({ ...closed, asOf: "2026-08-04T04:00:00.000Z" }, now)).toBe(true);
    expect(quoteIsAuthoritative({ ...closed, asOf: "2026-07-31T04:00:00.000Z" }, now)).toBe(false);
    expect(quoteIsAuthoritative({ ...closed, asOf: "2026-08-10T20:02:00.000Z" }, now)).toBe(false);
    expect(quoteIsAuthoritative({ ...closed, asOf: "2026-08-08T04:00:00.000Z", latestCompletedSession: false }, now)).toBe(false);
    expect(quoteIsAuthoritative({ ...closed, asOf: "2026-08-08T04:00:00.000Z", snapshotUpdatedAt: undefined }, now)).toBe(false);
    expect(quoteIsAuthoritative({ ...closed, asOf: "2026-08-08T04:00:00.000Z", snapshotUpdatedAt: "2000-01-01T00:00:00.000Z" }, now)).toBe(false);
  });

  it("rejects incomplete holding coverage before quotes can be authoritative", () => {
    const generation = "11111111-1111-4111-8111-111111111111";
    const coveredHoldings = [
      { ...holdings[0], provider: "plaid", connection_id: "c1", generation_id: generation },
      { ...holdings[1], provider: "plaid", connection_id: "c1", generation_id: generation },
    ];
    const connections = [{
      id: "c1",
      provider: "plaid",
      status: "linked",
      authority: "provider_verified",
      verified_at: new Date().toISOString(),
    }];
    expect(validateHoldingCoverage(coveredHoldings, connections, [{
      connection_id: "c1",
      provider: "plaid",
      component: "holdings",
      complete: true,
      availability_status: "available",
      record_count: 1,
      retrieved_at: new Date().toISOString(),
      generation_id: generation,
      generation_hash: "a".repeat(64),
    }])).toBe("HOLDING_COVERAGE_UNAVAILABLE");
    expect(validateHoldingCoverage(coveredHoldings, connections, [{
      connection_id: "c1",
      provider: "plaid",
      component: "holdings",
      complete: true,
      availability_status: "available",
      record_count: 2,
      retrieved_at: new Date().toISOString(),
      generation_id: generation,
      generation_hash: "a".repeat(64),
    }])).toBeNull();
  });

  it("does not serialize a missing position as numeric zero", () => {
    expect(calculateLivePosition("NVDA", holdings, new Map(), true)).toEqual({
      available: false,
      reason: "POSITION_NOT_FOUND",
      sharesMicro: null,
      costBasisMinor: null,
      positionValueMinor: null,
      unrealizedPLMinor: null,
      weight: null,
    });
  });

  it("keeps valid historical shares and basis but never substitutes basis for a missing quote", () => {
    expect(calculateLivePosition("AAPL", holdings, quotes([
      ["AAPL", null],
      ["MSFT", { price: "20.00", chg: 1 }],
    ]), true)).toEqual({
      available: false,
      reason: "QUOTE_UNAVAILABLE",
      sharesMicro: 1_005_000,
      costBasisMinor: 800,
      positionValueMinor: null,
      unrealizedPLMinor: null,
      weight: null,
    });
  });

  it("withholds weight and P/L when any portfolio quote is missing", () => {
    expect(calculateLivePosition("AAPL", holdings, quotes([
      ["AAPL", { price: "10.00", chg: 1 }],
      ["MSFT", null],
    ]), true)).toMatchObject({
      available: false,
      reason: "PORTFOLIO_QUOTES_INCOMPLETE",
      positionValueMinor: null,
      unrealizedPLMinor: null,
      weight: null,
    });
  });

  it.each([null, 0, -1, Number.NaN, "not-a-price"])(
    "rejects invalid quote %j instead of emitting zero live metrics",
    (price) => {
      const outcome = calculateLivePosition("AAPL", holdings, quotes([
        ["AAPL", { price, chg: 0 }],
        ["MSFT", { price: 20, chg: 0 }],
      ]), true);
      expect(outcome).toMatchObject({
        available: false,
        reason: "QUOTE_INVALID",
        positionValueMinor: null,
        unrealizedPLMinor: null,
        weight: null,
      });
    },
  );

  it("requires an FX contract rather than blending non-USD holdings", () => {
    expect(calculateLivePosition(
      "AAPL",
      [...holdings, { symbol: "SHOP", shares: "1", cost_basis: "5", currency: "CAD" }],
      quotes([
        ["AAPL", { price: 10, chg: 0 }],
        ["MSFT", { price: 20, chg: 0 }],
        ["SHOP", { price: 5, chg: 0 }],
      ]),
      true,
    )).toMatchObject({
      available: false,
      reason: "MIXED_CURRENCY_REQUIRES_FX",
      positionValueMinor: null,
      unrealizedPLMinor: null,
      weight: null,
    });
  });

  it("treats missing holding currency as unavailable instead of USD", () => {
    expect(calculateLivePosition(
      "AAPL",
      [{ symbol: "AAPL", shares: "1", cost_basis: "5" }],
      quotes([["AAPL", { price: 5, chg: 0 }]]),
      true,
    )).toMatchObject({ available: false, reason: "MIXED_CURRENCY_REQUIRES_FX" });
  });

  it("does not let a timed-out quote mutate the returned quote map later", async () => {
    vi.useFakeTimers();
    let finish: ((quote: NonNullable<PositionQuoteInput>) => void) | undefined;
    const pending = fetchPortfolioQuotes(
      ["AAPL"],
      () => new Promise((resolve) => { finish = resolve; }),
      50,
    );
    await vi.advanceTimersByTimeAsync(51);
    const result = await pending;
    expect(result).toMatchObject({ reason: "QUOTE_DEADLINE_EXCEEDED" });
    expect(result.quotes.size).toBe(0);
    finish?.({
      price: 10,
      chg: 0,
      source: "massive",
      asOf: new Date().toISOString(),
      observedAt: new Date().toISOString(),
      marketSession: "open",
    });
    await Promise.resolve();
    expect(result.quotes.size).toBe(0);
    vi.useRealTimers();
  });

  it("computes exact live metrics only with complete current quote coverage", () => {
    const outcome = calculateLivePosition("AAPL", holdings, quotes([
      ["AAPL", { price: "10.00", chg: 1 }],
      ["MSFT", { price: "20.00", chg: 2 }],
    ]), true);

    expect(outcome).toMatchObject({
      available: true,
      reason: null,
      sharesMicro: 1_005_000,
      costBasisMinor: 800,
      positionValueMinor: 1_005,
      unrealizedPLMinor: 205,
    });
    expect(outcome.weight).toBeCloseTo(10.05 / 50.05, 12);
  });

  it.each([
    ["0.5", "1.005", 50],
    ["1.5", "1.005", 151],
  ])("rounds %s shares at a %s quote only after multiplication", (shares, price, expectedMinor) => {
    const exactHolding = [{ symbol: "AXIS", shares, cost_basis: "0.00", currency: "USD" }];
    const outcome = calculateLivePosition("AXIS", exactHolding, quotes([
      ["AXIS", { price, chg: 0 }],
    ]), true);
    expect(outcome).toMatchObject({
      available: true,
      positionValueMinor: expectedMinor,
    });
  });
});
