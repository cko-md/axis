import { afterEach, beforeEach, describe, expect, it } from "vitest";
import crypto from "crypto";
import { providerMutationSemanticHash, providerMutationStableIdempotencyKey } from "./semanticHash";

describe("providerMutationSemanticHash", () => {
  const previous = process.env.PROVIDER_MUTATION_HMAC_KEY;
  beforeEach(() => { process.env.PROVIDER_MUTATION_HMAC_KEY = "test-provider-mutation-hmac-key-32chars"; });
  afterEach(() => {
    if (previous === undefined) delete process.env.PROVIDER_MUTATION_HMAC_KEY;
    else process.env.PROVIDER_MUTATION_HMAC_KEY = previous;
  });
  it("is stable across object key order and binds changed intent", () => {
    expect(providerMutationSemanticHash({ body: "private", to: "a@example.test" }))
      .toBe(providerMutationSemanticHash({ to: "a@example.test", body: "private" }));
    expect(providerMutationSemanticHash({ body: "private", to: "a@example.test" }))
      .not.toBe(providerMutationSemanticHash({ body: "changed", to: "a@example.test" }));
  });

  it("fails closed without a server key and is domain-separated from plain SHA-256", () => {
    delete process.env.PROVIDER_MUTATION_HMAC_KEY;
    expect(() => providerMutationSemanticHash({ body: "private" })).toThrow("HMAC key is unavailable");
    process.env.PROVIDER_MUTATION_HMAC_KEY = "test-provider-mutation-hmac-key-32chars";
    const plain = crypto.createHash("sha256").update('{"body":"private"}').digest("hex");
    expect(providerMutationSemanticHash({ body: "private" })).not.toBe(plain);
  });

  it("rejects cycles and oversized canonical input before hashing", () => {
    const cyclic: { self?: unknown } = {}; cyclic.self = cyclic;
    expect(() => providerMutationSemanticHash(cyclic)).toThrow("cycles");
    expect(() => providerMutationSemanticHash({ body: "x".repeat(65_000) })).toThrow("byte limit");
  });

  it("keeps non-sensitive idempotency identity stable across HMAC key rotation", () => {
    const identity = { protocol: "calendar-create-v1", userId: "u", eventId: "e", provider: "googlecalendar" };
    const before = providerMutationStableIdempotencyKey(identity);
    process.env.PROVIDER_MUTATION_HMAC_KEY = "rotated-provider-mutation-hmac-key-32chars";
    expect(providerMutationStableIdempotencyKey(identity)).toBe(before);
  });
});
