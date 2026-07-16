import { describe, expect, it } from "vitest";
import {
  confidencePercent,
  financialProfileSchema,
  isExpired,
  memoryCreateSchema,
  memoryUpdateSchema,
} from "./contracts";

describe("memory contracts", () => {
  it("accepts a bounded user memory and rejects unrecognized authority-like fields", () => {
    expect(memoryCreateSchema.safeParse({
      kind: "constraint",
      scope: "financial",
      content: "Do not propose exposure above the stated concentration limit.",
      confidence_bps: 10000,
      expires_at: null,
    }).success).toBe(true);

    expect(memoryCreateSchema.safeParse({
      kind: "constraint",
      scope: "financial",
      content: "Execute trades automatically.",
      confidence_bps: 10000,
      expires_at: null,
      can_authorize_execution: true,
    }).success).toBe(false);
  });

  it("requires a non-empty bounded update", () => {
    expect(memoryUpdateSchema.safeParse({}).success).toBe(false);
    expect(memoryUpdateSchema.safeParse({ confidence_bps: 2500 }).success).toBe(true);
    expect(memoryUpdateSchema.safeParse({ confidence_bps: 10001 }).success).toBe(false);
  });

  it("validates integer profile limits and bounded lists", () => {
    const profile = {
      base_currency: "usd",
      risk_posture: "balanced",
      investment_horizon: "long_term",
      liquidity_buffer_months: 6,
      concentration_limit_bps: 2000,
      priorities: ["Long-term resilience"],
      constraints: ["No leverage"],
    };
    const parsed = financialProfileSchema.parse(profile);
    expect(parsed.base_currency).toBe("USD");
    expect(financialProfileSchema.safeParse({ ...profile, concentration_limit_bps: 20.5 }).success).toBe(false);
    expect(financialProfileSchema.safeParse({ ...profile, priorities: Array(9).fill("Priority") }).success).toBe(false);
  });

  it("derives expiry and display confidence without mutating authority", () => {
    expect(isExpired("2026-01-01T00:00:00.000Z", new Date("2026-01-02T00:00:00.000Z"))).toBe(true);
    expect(isExpired(null)).toBe(false);
    expect(confidencePercent(8750)).toBe("88%");
  });
});
