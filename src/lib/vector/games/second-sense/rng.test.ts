import { describe, expect, it } from "vitest";
import {
  fnv1aHash,
  generateSecondSenseTargets,
  mulberry32,
  secondSenseDailyChallengeKey,
  secondSenseSeedForChallenge,
  SECOND_SENSE_DIFFICULTY_CONFIG,
} from "@/lib/vector/games/second-sense/rng";

describe("second sense rng", () => {
  it("hashes deterministically and sensitively to input", () => {
    expect(fnv1aHash("second-sense:daily:2026-07-18")).toBe(
      fnv1aHash("second-sense:daily:2026-07-18"),
    );
    expect(fnv1aHash("second-sense:daily:2026-07-18")).not.toBe(
      fnv1aHash("second-sense:daily:2026-07-19"),
    );
  });

  it("produces a fully deterministic PRNG sequence from a fixed seed", () => {
    const sequenceA = Array.from({ length: 5 }, () => 0).map((_, index) => {
      const random = mulberry32(42);
      // Advance the same number of steps each iteration to sample position `index`.
      let value = 0;
      for (let step = 0; step <= index; step += 1) value = random();
      return value;
    });
    const sequenceB = Array.from({ length: 5 }, () => 0).map((_, index) => {
      const random = mulberry32(42);
      let value = 0;
      for (let step = 0; step <= index; step += 1) value = random();
      return value;
    });
    expect(sequenceA).toEqual(sequenceB);
    for (const value of sequenceA) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("derives the daily challenge key from the UTC calendar day, not local time", () => {
    // 23:30 on 2026-07-18 in UTC-05:00 is already 2026-07-19 in UTC. The
    // contract is UTC day, so the key must be the later date, not the
    // wall-clock date this timestamp would show in that offset.
    const lateLocalEveningUtcNextDay = new Date("2026-07-18T23:30:00-05:00");
    expect(secondSenseDailyChallengeKey(lateLocalEveningUtcNextDay)).toBe("2026-07-19");

    // A timestamp explicitly at the UTC day boundary resolves to that day.
    expect(secondSenseDailyChallengeKey(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01-01");
    expect(secondSenseDailyChallengeKey(new Date("2026-12-31T23:59:59Z"))).toBe("2026-12-31");

    // Single-digit month/day are zero-padded.
    expect(secondSenseDailyChallengeKey(new Date("2026-03-05T12:00:00Z"))).toBe("2026-03-05");
  });

  it("builds distinct, stable seeds for daily vs practice challenges", () => {
    expect(secondSenseSeedForChallenge("daily", { dailyKey: "2026-07-18" })).toBe(
      "second-sense:daily:2026-07-18",
    );
    expect(secondSenseSeedForChallenge("practice", { practiceSeed: "abc123" })).toBe(
      "second-sense:practice:abc123",
    );
    expect(() => secondSenseSeedForChallenge("daily", {})).toThrow(
      "SECOND_SENSE_DAILY_KEY_REQUIRED",
    );
    expect(() => secondSenseSeedForChallenge("practice", {})).toThrow(
      "SECOND_SENSE_PRACTICE_SEED_REQUIRED",
    );
  });

  it("generates a deterministic, bounded target sequence per seed and difficulty", () => {
    const seed = secondSenseSeedForChallenge("daily", { dailyKey: "2026-07-18" });
    const first = generateSecondSenseTargets(seed, "easy");
    const second = generateSecondSenseTargets(seed, "easy");
    expect(first).toEqual(second);
    expect(first).toHaveLength(SECOND_SENSE_DIFFICULTY_CONFIG.easy.trialCount);
    for (const target of first) {
      expect(target).toBeGreaterThanOrEqual(SECOND_SENSE_DIFFICULTY_CONFIG.easy.minTargetMs);
      expect(target).toBeLessThanOrEqual(SECOND_SENSE_DIFFICULTY_CONFIG.easy.maxTargetMs);
    }

    const hard = generateSecondSenseTargets(seed, "hard");
    expect(hard).toHaveLength(SECOND_SENSE_DIFFICULTY_CONFIG.hard.trialCount);
    for (const target of hard) {
      expect(target).toBeGreaterThanOrEqual(SECOND_SENSE_DIFFICULTY_CONFIG.hard.minTargetMs);
      expect(target).toBeLessThanOrEqual(SECOND_SENSE_DIFFICULTY_CONFIG.hard.maxTargetMs);
    }

    expect(generateSecondSenseTargets("second-sense:daily:2026-07-19", "easy")).not.toEqual(first);
  });
});
