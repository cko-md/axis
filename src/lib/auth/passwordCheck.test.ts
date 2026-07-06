import { describe, expect, it } from "vitest";
import { PWNED_PASSWORD_MESSAGE, rangeContainsSuffix } from "@/lib/auth/passwordCheck";

// The HIBP range endpoint returns lines of "SUFFIX:count" (the SHA-1 suffix
// after the shared 5-char prefix). These cover the matching logic that decides
// whether a password is leaked.
const SUFFIX = "1E4C9B93F3F0682250B6CF8331B7EE68FD8"; // suffix of SHA1("password")

describe("rangeContainsSuffix", () => {
  it("matches a suffix with a positive breach count", () => {
    const body = `0018A45C4D1DEF81644B54AB7F969B88D65:1\n${SUFFIX}:9659365\nFFFF:2`;
    expect(rangeContainsSuffix(body, SUFFIX)).toBe(true);
  });

  it("does NOT match a padding entry (count 0)", () => {
    // Add-Padding injects fake suffixes with count 0 — must never be treated as a hit.
    const body = `${SUFFIX}:0\n0018A45C4D1DEF81644B54AB7F969B88D65:3`;
    expect(rangeContainsSuffix(body, SUFFIX)).toBe(false);
  });

  it("returns false when the suffix is absent", () => {
    expect(rangeContainsSuffix("ABCDEF:5\n123456:2", SUFFIX)).toBe(false);
  });

  it("is case-insensitive and tolerates CRLF + blank lines", () => {
    const body = `\r\n${SUFFIX.toLowerCase()}:42\r\n\r\n`;
    expect(rangeContainsSuffix(body, SUFFIX)).toBe(true);
  });

  it("handles an empty body", () => {
    expect(rangeContainsSuffix("", SUFFIX)).toBe(false);
  });

  it("exposes a user-facing message", () => {
    expect(PWNED_PASSWORD_MESSAGE).toMatch(/breach/i);
  });
});
