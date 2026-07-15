import { describe, expect, it } from "vitest";
import { parseSymbolList } from "./quotes";

describe("parseSymbolList", () => {
  it("uppercases, trims, and dedupes preserving first-seen order", () => {
    expect(parseSymbolList("aapl, msft , AAPL,nvda")).toEqual(["AAPL", "MSFT", "NVDA"]);
  });

  it("drops invalid tokens", () => {
    expect(parseSymbolList("AAPL,,  ,not a symbol,GOOG")).toEqual(["AAPL", "GOOG"]);
  });

  it("allows crypto/exchange-style symbols", () => {
    expect(parseSymbolList("X:BTCUSD,BRK.B")).toEqual(["X:BTCUSD", "BRK.B"]);
  });

  it("caps the list length", () => {
    const many = Array.from({ length: 40 }, (_, i) => `S${i}`).join(",");
    expect(parseSymbolList(many, 25)).toHaveLength(25);
  });

  it("returns [] for empty/nullish input", () => {
    expect(parseSymbolList("")).toEqual([]);
    expect(parseSymbolList(null)).toEqual([]);
    expect(parseSymbolList(undefined)).toEqual([]);
  });
});
