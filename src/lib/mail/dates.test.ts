import { describe, expect, it } from "vitest";
import {
  compareMailDateDesc,
  getMailDateTime,
  normalizeMailDate,
} from "./dates";

describe("mail date helpers", () => {
  it("normalizes RFC 2822 provider dates to ISO strings", () => {
    expect(normalizeMailDate("Thu, 1 Jan 2025 00:00:00 +0000")).toBe("2025-01-01T00:00:00.000Z");
  });

  it("normalizes numeric provider timestamps in milliseconds", () => {
    expect(normalizeMailDate("1735689600000")).toBe("2025-01-01T00:00:00.000Z");
  });

  it("normalizes numeric provider timestamps in seconds", () => {
    expect(normalizeMailDate(1735689600)).toBe("2025-01-01T00:00:00.000Z");
  });

  it("returns empty string and null time for missing or invalid dates", () => {
    expect(normalizeMailDate("not a date")).toBe("");
    expect(normalizeMailDate("")).toBe("");
    expect(getMailDateTime("not a date")).toBeNull();
  });

  it("sorts newest first and pushes invalid dates last", () => {
    const newest = { id: "b", provider: "gmail", accountEmail: "a", date: "2025-01-02T00:00:00.000Z" };
    const oldest = { id: "a", provider: "gmail", accountEmail: "a", date: "2025-01-01T00:00:00.000Z" };
    const invalid = { id: "c", provider: "gmail", accountEmail: "a", date: "" };

    expect([oldest, invalid, newest].sort(compareMailDateDesc)).toEqual([newest, oldest, invalid]);
  });

  it("uses identity as a deterministic tie-breaker", () => {
    const a = { id: "a", provider: "gmail", accountEmail: "a", date: "" };
    const b = { id: "b", provider: "gmail", accountEmail: "a", date: "" };

    expect([b, a].sort(compareMailDateDesc)).toEqual([a, b]);
  });
});
