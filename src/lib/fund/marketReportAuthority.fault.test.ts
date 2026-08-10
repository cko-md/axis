import { describe, expect, it } from "vitest";
import {
  authoritativeMarketReportHoldings,
  marketReportInput,
  marketReportSources,
} from "./marketReport";

describe("market report source provenance", () => {
  it("bounds, de-duplicates, and preserves only displayable source metadata", () => {
    const sources = marketReportSources([
      { title: "First", url: "https://example.com/one", publisher: "Example", tickers: ["aapl"], publishedAt: "2026-07-15T12:00:00Z" },
      { title: "Duplicate", url: "https://example.com/one", publisher: "Example", tickers: [], publishedAt: "2026-07-15T12:00:00Z" },
      { title: "Second", url: "https://example.com/two", publisher: "Example", tickers: ["msft", ""], publishedAt: "2026-07-15T13:00:00Z" },
      { title: "Unsafe", url: "javascript:alert(1)", publisher: "Example", tickers: [], publishedAt: "2026-07-15T13:00:00Z" },
    ]);

    expect(sources).toEqual([
      { title: "First", url: "https://example.com/one", publisher: "Example", tickers: ["AAPL"], publishedAt: "2026-07-15T12:00:00Z" },
      { title: "Second", url: "https://example.com/two", publisher: "Example", tickers: ["MSFT"], publishedAt: "2026-07-15T13:00:00Z" },
    ]);
  });

  it("keeps URLs out of the model input while retaining a bounded portfolio summary", () => {
    const input = marketReportInput({
      holdings: [{ symbol: "aapl", name: "Apple", shares: 2, costBasis: 190.12 }],
      watchlist: [{ symbol: "nvda" }],
      sources: [{ title: "A source", url: "https://example.com/private-path", publisher: "Example", tickers: ["aapl"], publishedAt: "2026-07-15T12:00:00Z" }],
    });

    expect(input).toContain('"symbol":"AAPL"');
    expect(input).toContain('"watchlist":["NVDA"]');
    expect(input).not.toContain("private-path");
  });

  it("withholds manual holdings from AI portfolio context", () => {
    expect(authoritativeMarketReportHoldings([{
      symbol: "AAPL",
      name: "Apple",
      shares: "2",
      cost_basis: "999999.00",
      currency: "USD",
      authority: "manual",
      source: "manual",
    }], [], [])).toEqual({
      holdings: [],
      reason: "HOLDING_PROVENANCE_UNAVAILABLE",
    });
  });

  it("passes only complete fresh provider holdings without cost basis", () => {
    const now = new Date().toISOString();
    const generationId = "11111111-1111-4111-8111-111111111111";
    expect(authoritativeMarketReportHoldings([{
      symbol: "AAPL",
      name: "Apple",
      shares: "2",
      cost_basis: "999999.00",
      currency: "USD",
      authority: "provider",
      source: "plaid",
      provider: "plaid",
      provider_record_id: "holding-1",
      connection_id: "connection-1",
      retrieved_at: now,
      reconciliation_state: "matched",
      generation_id: generationId,
    }], [{
      id: "connection-1",
      provider: "plaid",
      status: "linked",
      authority: "provider_verified",
      verified_at: now,
    }], [{
      connection_id: "connection-1",
      provider: "plaid",
      component: "holdings",
      complete: true,
      record_count: 1,
      retrieved_at: now,
      availability_status: "available",
      generation_id: generationId,
      generation_hash: "a".repeat(64),
    }])).toEqual({
      holdings: [{ symbol: "AAPL", name: "Apple" }],
      reason: null,
    });
  });
});
