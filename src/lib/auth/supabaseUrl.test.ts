import { describe, expect, it } from "vitest";
import { isAllowedSupabaseUrl } from "./supabaseUrl";

describe("isAllowedSupabaseUrl", () => {
  it("allows HTTPS origins and exact local loopback HTTP", () => {
    expect(isAllowedSupabaseUrl("https://project.supabase.co")).toBe(true);
    expect(isAllowedSupabaseUrl("http://127.0.0.1:54321")).toBe(true);
  });

  it("rejects blank, malformed, and non-loopback HTTP URLs", () => {
    ["", "not a url", "ftp://project.supabase.co", "file:///tmp/db", "http://localhost:54321", "http://127.0.0.2:54321"].forEach((value) => {
      expect(isAllowedSupabaseUrl(value)).toBe(false);
    });
  });
});
