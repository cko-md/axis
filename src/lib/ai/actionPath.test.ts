import { describe, expect, it } from "vitest";
import { safeActionPath } from "./actionPath";

describe("safeActionPath", () => {
  it("allows known internal routes and preserves query strings", () => {
    expect(safeActionPath("/agenda?view=week")).toBe("/agenda?view=week");
  });

  it("rejects external, protocol-relative, and unknown routes", () => {
    expect(safeActionPath("https://example.com")).toBeUndefined();
    expect(safeActionPath("//example.com")).toBeUndefined();
    expect(safeActionPath("/api/admin")).toBeUndefined();
  });
});
