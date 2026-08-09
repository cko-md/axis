import { describe, expect, it } from "vitest";
import { preparePublicOrder } from "./publicOrderAdapter";
import {
  buildFundOrderIntentDraft,
  hashFundOrderIntentDraft,
  normalizeOrderIntentIdempotencyKey,
} from "./orderIntent";

describe("fund order intent", () => {
  it("normalizes an exact, explicitly not-submitted financial intent", () => {
    const prepared = preparePublicOrder({
      symbol: "aapl",
      side: "buy",
      quantity: "1.250000",
      referencePrice: "195.12",
      currency: "USD",
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    const draft = buildFundOrderIntentDraft(prepared.data);
    expect(draft).toMatchObject({
      actionClass: "FINANCIAL_EXECUTION",
      symbol: "AAPL",
      side: "buy",
      quantityUnits: 1_250_000,
      quantityScale: 1_000_000,
      referencePriceMinor: 19_512,
      referencePriceSource: "manual_estimate",
      estimatedNotionalMinor: 24_390,
      status: "not_submitted",
    });
  });

  it("hashes identical retry payloads identically and changed payloads differently", () => {
    const first = preparePublicOrder({ symbol: "VOO", side: "buy", quantity: 1, currency: "USD" });
    const second = preparePublicOrder({ symbol: "VOO", side: "sell", quantity: 1, currency: "USD" });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(hashFundOrderIntentDraft(buildFundOrderIntentDraft(first.data))).toBe(
      hashFundOrderIntentDraft(buildFundOrderIntentDraft(first.data)),
    );
    expect(hashFundOrderIntentDraft(buildFundOrderIntentDraft(first.data))).not.toBe(
      hashFundOrderIntentDraft(buildFundOrderIntentDraft(second.data)),
    );
  });

  it("accepts only UUID idempotency keys", () => {
    expect(normalizeOrderIntentIdempotencyKey("11111111-1111-4111-8111-111111111111")).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(normalizeOrderIntentIdempotencyKey("retry-me")).toBeNull();
  });
});
