import { afterEach, describe, expect, it, vi } from "vitest";

const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const originalAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

afterEach(() => {
  vi.resetModules();
  if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  else process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
  if (originalAnonKey === undefined) {
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  } else {
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = originalAnonKey;
  }
});

async function readPublicEnv(url: string) {
  vi.resetModules();
  process.env.NEXT_PUBLIC_SUPABASE_URL = url;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
  const { getPublicEnv } = await import("./env");
  return getPublicEnv();
}

describe("required public environment security boundary", () => {
  it.each([
    "ftp://127.0.0.1",
    "file://127.0.0.1/tmp",
    "http://example.supabase.co",
  ])("rejects a URL the Supabase client cannot safely use: %s", async (url) => {
    await expect(readPublicEnv(url)).rejects.toThrow(
      "Missing or invalid required AXIS environment variable",
    );
  });

  it.each([
    "https://example.supabase.co",
    "http://127.0.0.1:54321",
  ])("accepts a supported Supabase transport: %s", async (url) => {
    await expect(readPublicEnv(url)).resolves.toMatchObject({
      NEXT_PUBLIC_SUPABASE_URL: url,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
    });
  });
});
