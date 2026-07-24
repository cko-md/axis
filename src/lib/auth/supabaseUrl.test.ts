import { describe, expect, it } from "vitest";
import { isAllowedSupabaseUrl } from "./supabaseUrl";

describe("Supabase URL transport policy", () => {
  it.each([
    "https://example.supabase.co",
    "https://example.supabase.co:8443",
    "http://127.0.0.1:54321",
  ])("accepts an allowed Supabase origin: %s", (value) => {
    expect(isAllowedSupabaseUrl(value)).toBe(true);
  });

  it.each([
    "ftp://127.0.0.1",
    "file://127.0.0.1/tmp",
    "http://example.supabase.co",
    "http://localhost:54321",
    "not-a-url",
  ])("rejects an unsafe or malformed Supabase origin: %s", (value) => {
    expect(isAllowedSupabaseUrl(value)).toBe(false);
  });
});
