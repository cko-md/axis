import { afterEach, describe, expect, it, vi } from "vitest";
import { ADMISSION_POLICIES, admit, resetLocalAdmissionForTest } from "@/lib/admission";

afterEach(() => {
  vi.unstubAllEnvs();
  resetLocalAdmissionForTest();
});

describe("admission", () => {
  it("uses only a bounded local fallback outside hosted runtime", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
    vi.stubEnv("QUOTA_SUBJECT_SECRET", "test-only-subject-secret");
    const policy = { ...ADMISSION_POLICIES.mfaVerify, limit: 1 };
    expect((await admit("verified-user", policy)).kind).toBe("allowed");
    const limited = await admit("verified-user", policy);
    expect(limited.kind).toBe("limited");
    if (limited.kind === "limited") expect(limited.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it("fails closed on missing distributed quota configuration in hosted runtime", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
    vi.stubEnv("QUOTA_SUBJECT_SECRET", "");
    await expect(admit("verified-user", ADMISSION_POLICIES.mfaVerify)).resolves.toEqual({ kind: "unavailable", reason: "not_configured" });
  });

  it("rejects malformed hosted Redis configuration instead of falling back", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("QUOTA_SUBJECT_SECRET", "test-only-subject-secret");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "http://not-https");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "token");
    await expect(admit("verified-user", ADMISSION_POLICIES.mfaVerify)).resolves.toEqual({ kind: "unavailable", reason: "malformed" });
  });

  it("evicts old local subjects instead of growing an unbounded process store", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
    vi.stubEnv("QUOTA_SUBJECT_SECRET", "test-only-subject-secret");
    const policy = { ...ADMISSION_POLICIES.mfaVerify, limit: 1 };

    await expect(admit("oldest-subject", policy)).resolves.toEqual({
      kind: "allowed",
    });
    for (let index = 0; index < 2_001; index += 1) {
      await admit(`bounded-subject-${index}`, policy);
    }

    // If the oldest entry survived, its second call would be limited.
    await expect(admit("oldest-subject", policy)).resolves.toEqual({
      kind: "allowed",
    });
  });
});
