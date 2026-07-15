import { describe, expect, it } from "vitest";
import { hmacSha256Hex, timingSafeStringEqual, verifyHmacSha256Hex } from "./webhookSignature";

describe("webhook signatures", () => {
  it("verifies an HMAC-SHA256 hex signature over the exact raw body", () => {
    const rawBody = JSON.stringify({ event: "ping", idempotency_key: "abc" });
    const signature = hmacSha256Hex("secret", rawBody);

    expect(verifyHmacSha256Hex({ secret: "secret", rawBody, signature })).toBe(true);
    expect(verifyHmacSha256Hex({ secret: "secret", rawBody: `${rawBody}\n`, signature })).toBe(false);
  });

  it("rejects malformed, missing, or wrong signatures", () => {
    const rawBody = "{}";
    expect(verifyHmacSha256Hex({ secret: "secret", rawBody, signature: null })).toBe(false);
    expect(verifyHmacSha256Hex({ secret: "secret", rawBody, signature: "not-hex" })).toBe(false);
    expect(verifyHmacSha256Hex({ secret: "secret", rawBody, signature: "0".repeat(64) })).toBe(false);
  });

  it("compares different-length strings without throwing", () => {
    expect(timingSafeStringEqual("abc", "abc")).toBe(true);
    expect(timingSafeStringEqual("abc", "abcd")).toBe(false);
    expect(timingSafeStringEqual(undefined, "abc")).toBe(false);
  });
});
