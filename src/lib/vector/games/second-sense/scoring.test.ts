import { describe, expect, it } from "vitest";
import {
  absoluteErrorMs,
  aggregateSecondSenseTrials,
  fromPersistedScore,
  proportionalError,
  scoreTrial,
  SECOND_SENSE_SCORE_CEILING,
  toPersistedScore,
} from "@/lib/vector/games/second-sense/scoring";

describe("second sense scoring", () => {
  it("computes absolute error symmetrically", () => {
    expect(absoluteErrorMs(1000, 1000)).toBe(0);
    expect(absoluteErrorMs(1000, 1200)).toBe(200);
    expect(absoluteErrorMs(1000, 800)).toBe(200);
  });

  it("computes proportional error relative to the target", () => {
    expect(proportionalError(500, 600)).toBeCloseTo(0.2, 10);
    expect(proportionalError(4000, 4100)).toBeCloseTo(0.025, 10);
    expect(() => proportionalError(0, 100)).toThrow("SECOND_SENSE_INVALID_TARGET");
  });

  it("scores a single trial as both absolute and proportional error", () => {
    expect(scoreTrial({ targetMs: 2000, actualMs: 2100 })).toEqual({
      targetMs: 2000,
      actualMs: 2100,
      absoluteErrorMs: 100,
      proportionalError: 0.05,
    });
  });

  it("aggregates a completed set of trials as a mean", () => {
    const trials = [
      scoreTrial({ targetMs: 1000, actualMs: 1100 }), // abs 100, prop 0.1
      scoreTrial({ targetMs: 2000, actualMs: 1800 }), // abs 200, prop 0.1
      scoreTrial({ targetMs: 3000, actualMs: 3000 }), // abs 0, prop 0
    ];
    const aggregate = aggregateSecondSenseTrials(trials);
    expect(aggregate.trialCount).toBe(3);
    expect(aggregate.meanAbsoluteErrorMs).toBeCloseTo(100, 10);
    expect(aggregate.meanProportionalError).toBeCloseTo(0.0667, 3);
  });

  it("refuses to score an empty run rather than fabricate a result", () => {
    expect(() => aggregateSecondSenseTrials([])).toThrow("SECOND_SENSE_NO_TRIALS");
  });

  it("maps lower error to a higher persisted score (best = Math.max under the shared merge)", () => {
    const betterRun = toPersistedScore(50);
    const worseRun = toPersistedScore(500);
    expect(betterRun).toBeGreaterThan(worseRun);
    expect(betterRun).toBe(SECOND_SENSE_SCORE_CEILING - 50);
  });

  it("clamps the persisted score at zero for pathological input", () => {
    expect(toPersistedScore(SECOND_SENSE_SCORE_CEILING + 1000)).toBe(0);
  });

  it("round-trips a persisted score back to an approximate error for display", () => {
    const persisted = toPersistedScore(120);
    expect(fromPersistedScore(persisted)).toBe(120);
    expect(fromPersistedScore(SECOND_SENSE_SCORE_CEILING + 1)).toBe(0);
  });
});
