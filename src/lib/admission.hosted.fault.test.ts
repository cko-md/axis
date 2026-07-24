import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  limit: vi.fn(),
  fromEnv: vi.fn(),
  slidingWindow: vi.fn(),
}));

vi.mock("@upstash/redis", () => ({
  Redis: {
    fromEnv: (...args: unknown[]) => mocks.fromEnv(...args),
  },
}));
vi.mock("@upstash/ratelimit", () => {
  class TestRatelimit {
    static slidingWindow(...args: unknown[]) {
      return mocks.slidingWindow(...args);
    }

    limit(...args: unknown[]) {
      return mocks.limit(...args);
    }
  }
  return { Ratelimit: TestRatelimit };
});
vi.mock("@/lib/observability/captureRouteError", () => ({
  captureRouteError: vi.fn(),
}));

import {
  ADMISSION_POLICIES,
  admissionResponse,
  admit,
  resetLocalAdmissionForTest,
} from "@/lib/admission";

describe("hosted distributed admission fault behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://redis.example.test");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "test-token");
    vi.stubEnv("QUOTA_SUBJECT_SECRET", "test-only-subject-secret");
    mocks.fromEnv.mockReturnValue({ kind: "redis-client" });
    mocks.slidingWindow.mockReturnValue({ kind: "sliding-window" });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetLocalAdmissionForTest();
  });

  it("returns unavailable rather than 429 or local fallback on Redis errors", async () => {
    mocks.limit.mockRejectedValue(new Error("redis connection failed"));

    const decision = await admit(
      "verified-user",
      ADMISSION_POLICIES.mfaVerify,
    );

    expect(decision).toEqual({ kind: "unavailable", reason: "backend" });
    expect(admissionResponse(decision)?.status).toBe(503);
  });

  it("maps actual distributed exhaustion to 429 with a bounded retry-after", async () => {
    mocks.limit.mockResolvedValue({
      success: false,
      reset: Date.now() + 3_500,
    });

    const decision = await admit(
      "verified-user",
      ADMISSION_POLICIES.mfaVerify,
    );
    const response = admissionResponse(decision);

    expect(decision).toMatchObject({ kind: "limited" });
    expect(response?.status).toBe(429);
    expect(Number(response?.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(Number(response?.headers.get("retry-after"))).toBeLessThanOrEqual(3600);
  });
});
