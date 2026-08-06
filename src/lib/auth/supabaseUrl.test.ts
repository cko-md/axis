import { describe, expect, it } from "vitest";
import {
  AXIS_SUPABASE_LOCAL_ORIGIN,
  AXIS_SUPABASE_PRODUCTION_ORIGIN,
  isAllowedSupabaseUrl,
} from "./supabaseUrl";

describe("isAllowedSupabaseUrl", () => {
  it("allows only the exact AXIS production and local origins", () => {
    for (const value of [
      AXIS_SUPABASE_PRODUCTION_ORIGIN,
      `${AXIS_SUPABASE_PRODUCTION_ORIGIN}/`,
      AXIS_SUPABASE_LOCAL_ORIGIN,
      `${AXIS_SUPABASE_LOCAL_ORIGIN}/`,
    ]) {
      expect(isAllowedSupabaseUrl(value)).toBe(true);
    }
  });

  it("rejects every unpinned or non-origin URL", () => {
    [
      "",
      "not a url",
      "ftp://project.supabase.co",
      "file:///tmp/db",
      "https://project.supabase.co",
      "https://example.com",
      "https://twkcvyhmlguipchfetge.supabase.co.evil.example",
      "https://user:password@twkcvyhmlguipchfetge.supabase.co",
      "https://twkcvyhmlguipchfetge.supabase.co:444",
      "https://twkcvyhmlguipchfetge.supabase.co/rest/v1",
      "https://twkcvyhmlguipchfetge.supabase.co?redirect=evil",
      "https://twkcvyhmlguipchfetge.supabase.co#fragment",
      "http://localhost:54321",
      "http://127.0.0.1",
      "http://127.0.0.1:54322",
      "http://127.0.0.2:54321",
    ].forEach((value) => {
      expect(isAllowedSupabaseUrl(value)).toBe(false);
    });
  });
});
