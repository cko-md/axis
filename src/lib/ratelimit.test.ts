import { describe, it, expect, vi } from "vitest";
import { memoryRateLimit } from "./ratelimit";

// memoryRateLimit uses a module-level Map — since we can't reset it, we use
// unique keys per test to avoid cross-contamination.

describe("memoryRateLimit()", () => {
  it("allows first request", () => {
    const r = memoryRateLimit(`test-allow-${Date.now()}`, 5, 60_000);
    expect(r.success).toBe(true);
  });

  it("allows up to the limit", () => {
    const key = `test-limit-${Date.now()}`;
    for (let i = 0; i < 5; i++) {
      expect(memoryRateLimit(key, 5, 60_000).success).toBe(true);
    }
  });

  it("rejects requests beyond the limit", () => {
    const key = `test-beyond-${Date.now()}`;
    for (let i = 0; i < 5; i++) {
      memoryRateLimit(key, 5, 60_000);
    }
    expect(memoryRateLimit(key, 5, 60_000).success).toBe(false);
  });

  it("resets after the window expires (uses fake timers)", () => {
    const key = `test-reset-fake`;
    vi.useFakeTimers({ now: 1000 });

    for (let i = 0; i < 3; i++) {
      memoryRateLimit(key, 3, 10_000);
    }
    expect(memoryRateLimit(key, 3, 10_000).success).toBe(false);

    // Advance past the window
    vi.advanceTimersByTime(10_001);
    expect(memoryRateLimit(key, 3, 10_000).success).toBe(true);

    vi.useRealTimers();
  });

  it("tracks different keys independently", () => {
    const keyA = `test-indep-a-${Date.now()}`;
    const keyB = `test-indep-b-${Date.now()}`;
    memoryRateLimit(keyA, 1, 60_000);
    expect(memoryRateLimit(keyA, 1, 60_000).success).toBe(false);
    expect(memoryRateLimit(keyB, 1, 60_000).success).toBe(true);
  });

  it("counts incrementally within the window", () => {
    const key = `test-count-${Date.now()}`;
    expect(memoryRateLimit(key, 10, 60_000).success).toBe(true);
    // Second call should succeed — count is now 2
    expect(memoryRateLimit(key, 10, 60_000).success).toBe(true);
  });
});
