import { describe, expect, it } from "vitest";
import { normalizeQuote } from "./quote";

const NOW = Date.parse("2026-07-14T15:00:00.000Z");

describe("normalizeQuote", () => {
  it("stamps provenance and marks a just-now price fresh", () => {
    const q = normalizeQuote("aapl", { price: 212.34, chg: 1.2, ts: NOW - 30_000 }, {
      provider: "polygon",
      now: NOW,
    });
    expect(q.symbol).toBe("AAPL");
    expect(q.price).toBe(212.34);
    expect(q.currency).toBe("USD");
    expect(q.provenance.provider).toBe("polygon");
    expect(q.provenance.effectiveAt).toBe(new Date(NOW - 30_000).toISOString());
    expect(q.freshness).toBe("fresh");
  });

  it("classifies an old bar as delayed/stale via the market SLA", () => {
    // marketPrice SLA: fresh <=60s, stale >15m.
    const delayed = normalizeQuote("MSFT", { price: 400, chg: 0, ts: NOW - 5 * 60_000 }, { provider: "polygon", now: NOW });
    expect(delayed.freshness).toBe("delayed");
    const stale = normalizeQuote("MSFT", { price: 400, chg: 0, ts: NOW - 60 * 60_000 }, { provider: "polygon", now: NOW });
    expect(stale.freshness).toBe("stale");
  });

  it("uses retrieval time when the provider gives no bar timestamp", () => {
    const q = normalizeQuote("BTC", { price: 65000, chg: -2 }, { provider: "polygon", now: NOW });
    expect(q.provenance.effectiveAt).toBeUndefined();
    expect(q.provenance.retrievedAt).toBe(new Date(NOW).toISOString());
    expect(q.freshness).toBe("fresh");
  });

  it("coerces non-finite price/change to 0 (never NaN)", () => {
    const q = normalizeQuote("X", { price: Number.NaN, chg: Number.POSITIVE_INFINITY }, { provider: "polygon", now: NOW });
    expect(q.price).toBe(0);
    expect(q.changePct).toBe(0);
  });

  it("honors a non-USD currency override", () => {
    const q = normalizeQuote("VOD", { price: 70, chg: 0.5 }, { provider: "polygon", now: NOW, currency: "GBP" });
    expect(q.currency).toBe("GBP");
    expect(q.provenance.currency).toBe("GBP");
  });
});
