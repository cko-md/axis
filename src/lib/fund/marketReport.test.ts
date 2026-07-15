import { describe, expect, it } from "vitest";
import { marketReportInput, marketReportSources } from "./marketReport";

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
});
