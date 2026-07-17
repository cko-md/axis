import { describe, expect, it } from "vitest";
import { toEntitySearchPattern } from "./candidates";

describe("toEntitySearchPattern", () => {
  it("matches separate words across stored identifier separators", () => {
    expect(toEntitySearchPattern(" financial execution ")).toBe("%financial%execution%");
  });

  it("removes PostgREST filter syntax instead of forwarding it", () => {
    expect(toEntitySearchPattern("%,name.ilike.%")).toBe("%name.ilike.%");
  });

  it("returns null for an empty or syntax-only query", () => {
    expect(toEntitySearchPattern("%_\\(),")).toBeNull();
  });
});
