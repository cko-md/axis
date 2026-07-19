/**
 * Pure, deterministic scoring for Second Sense. No randomness, no DOM, no
 * platform dependency — every function here takes numbers in and returns
 * numbers out, so the timing math can be unit-tested independently of the
 * Canvas/DOM engine that drives it.
 */

export type SecondSenseTrialResult = {
  targetMs: number;
  actualMs: number;
};

export type SecondSenseTrialError = {
  targetMs: number;
  actualMs: number;
  absoluteErrorMs: number;
  proportionalError: number;
};

/** |actual - target|, in milliseconds. Never negative. */
export function absoluteErrorMs(targetMs: number, actualMs: number): number {
  return Math.abs(actualMs - targetMs);
}

/**
 * Error relative to the target duration. A 100ms miss on a 500ms target
 * (0.2) is worse than the same 100ms miss on a 4000ms target (0.025) — this
 * is what lets Easy and Hard scores mean the same thing despite very
 * different absolute interval lengths.
 */
export function proportionalError(targetMs: number, actualMs: number): number {
  if (targetMs <= 0) throw new Error("SECOND_SENSE_INVALID_TARGET");
  return absoluteErrorMs(targetMs, actualMs) / targetMs;
}

export function scoreTrial(result: SecondSenseTrialResult): SecondSenseTrialError {
  return {
    targetMs: result.targetMs,
    actualMs: result.actualMs,
    absoluteErrorMs: absoluteErrorMs(result.targetMs, result.actualMs),
    proportionalError: proportionalError(result.targetMs, result.actualMs),
  };
}

export type SecondSenseAggregateScore = {
  trialCount: number;
  meanAbsoluteErrorMs: number;
  meanProportionalError: number;
};

/**
 * Aggregate a completed set of trials. Requires at least one trial — an empty
 * run has no score, and callers must not fabricate one.
 */
export function aggregateSecondSenseTrials(
  trials: readonly SecondSenseTrialError[],
): SecondSenseAggregateScore {
  if (trials.length === 0) throw new Error("SECOND_SENSE_NO_TRIALS");
  let absoluteTotal = 0;
  let proportionalTotal = 0;
  for (const trial of trials) {
    absoluteTotal += trial.absoluteErrorMs;
    proportionalTotal += trial.proportionalError;
  }
  return {
    trialCount: trials.length,
    meanAbsoluteErrorMs: absoluteTotal / trials.length,
    meanProportionalError: proportionalTotal / trials.length,
  };
}

/**
 * The platform's shared score contract treats a LARGER persisted value as
 * better (see mergeVectorBestScore: Math.max(current, incoming)), but Second
 * Sense is a lower-error-wins game. This ceiling transform makes the two
 * models agree without changing the shared contract: a smaller mean error
 * yields a larger persisted integer, so "best" under the shared merge is
 * still "lowest error" under the game's own rules.
 *
 * The ceiling is far above any reachable error (worst case is roughly one
 * maxTargetMs miss, ~4000ms) so the transform never goes negative in normal
 * play; it clamps to 0 defensively for pathological input.
 */
export const SECOND_SENSE_SCORE_CEILING = 1_000_000;

export function toPersistedScore(meanAbsoluteErrorMs: number): number {
  return Math.max(0, Math.round(SECOND_SENSE_SCORE_CEILING - meanAbsoluteErrorMs));
}

export function fromPersistedScore(persistedScore: number): number {
  return Math.max(0, SECOND_SENSE_SCORE_CEILING - persistedScore);
}
