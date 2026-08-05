import { afterEach, describe, expect, it, vi } from "vitest";

const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const originalKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

async function loadEnv() {
  vi.resetModules();
  return import("./env");
}

function setEnv(name: "NEXT_PUBLIC_SUPABASE_URL" | "NEXT_PUBLIC_SUPABASE_ANON_KEY", value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  else process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
  if (originalKey === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = originalKey;
});

describe("public Supabase environment validation", () => {
  it.each([
    undefined,
    "",
    "   ",
    "ftp://project.supabase.co",
    "https://project.supabase.co",
    "http://localhost:54321",
  ])(
    "rejects an unavailable or invalid URL: %s",
    async (url) => {
      setEnv("NEXT_PUBLIC_SUPABASE_URL", url);
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
      const { getPublicEnv } = await loadEnv();
      expect(() => getPublicEnv()).toThrow("NEXT_PUBLIC_SUPABASE_URL");
    },
  );

  it.each([undefined, "", "   "])("rejects a blank anon key: %s", async (key) => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://twkcvyhmlguipchfetge.supabase.co";
    setEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", key);
    const { getPublicEnv } = await loadEnv();
    expect(() => getPublicEnv()).toThrow("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  });

  it("accepts the configured HTTPS URL and a nonblank key", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://twkcvyhmlguipchfetge.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
    const { getPublicEnv } = await loadEnv();
    expect(getPublicEnv()).toMatchObject({
      NEXT_PUBLIC_SUPABASE_URL: "https://twkcvyhmlguipchfetge.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
    });
  });
});
