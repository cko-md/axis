import { describe, expect, it } from "vitest";
import { estimateCostUsd, estimateTokens, pricingKeyForModel } from "./cost";

describe("estimateTokens", () => {
  it("approximates 4 chars per token", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });
});

describe("pricingKeyForModel", () => {
  it("maps router model strings to price keys", () => {
    expect(pricingKeyForModel("claude/haiku-4-5")).toBe("haiku");
    expect(pricingKeyForModel("gemini/gemini-2.5-flash")).toBe("gemini-flash");
    expect(pricingKeyForModel("gemini/gemini-1.5-pro")).toBe("gemini-pro");
    expect(pricingKeyForModel("some/unknown-model")).toBeNull();
  });
});

describe("estimateCostUsd", () => {
  it("prices input + output by model", () => {
    // 400 in / 400 out chars = 100 in / 100 out tokens on haiku (0.8 / 4 per 1M).
    const cost = estimateCostUsd("claude/haiku-4-5", "a".repeat(400), "b".repeat(400));
    // 100/1e6*0.8 + 100/1e6*4 = 0.00008 + 0.0004 = 0.00048
    expect(cost).toBeCloseTo(0.00048, 6);
  });

  it("falls back to a conservative price for unknown models", () => {
    const cost = estimateCostUsd("mystery", "a".repeat(4), "b".repeat(4)); // 1 in / 1 out token
    // 1/1e6*1 + 1/1e6*5 = 0.000006
    expect(cost).toBeCloseTo(0.000006, 6);
  });

  it("is 0 for empty text", () => {
    expect(estimateCostUsd("claude/haiku-4-5", "", "")).toBe(0);
  });
});
