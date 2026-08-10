import { describe, expect, it } from "vitest";
import { normalizeUsEquitySymbol } from "./equitySymbol";

describe("canonical US equity symbols", () => {
  it.each(["AAPL", "BRK.B", "BF-B", "googl"])("accepts %s", (value) => {
    expect(normalizeUsEquitySymbol(value)).toBe(value.toUpperCase());
  });

  it.each(["$$$", "A/B", "A..B", "A.-B", "A B", ".A", "A-", ""])("rejects %s", (value) => {
    expect(normalizeUsEquitySymbol(value)).toBeNull();
  });
});
