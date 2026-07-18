/**
 * Deterministic randomness for Second Sense.
 *
 * Every trial sequence — practice or daily — is derived from a string seed
 * through a pure, dependency-free PRNG. The same seed always produces the
 * same five target durations, on any device, forever. This is what makes the
 * daily challenge fair (every player sees the same intervals) and what makes
 * the scoring math testable (no hidden entropy).
 */

export type SecondSenseDifficulty = "easy" | "hard";

export type SecondSenseDifficultyConfig = {
  /** Inclusive millisecond bounds for a generated target interval. */
  readonly minTargetMs: number;
  readonly maxTargetMs: number;
  readonly trialCount: number;
};

export const SECOND_SENSE_DIFFICULTY_CONFIG: Readonly<
  Record<SecondSenseDifficulty, SecondSenseDifficultyConfig>
> = Object.freeze({
  easy: Object.freeze({ minTargetMs: 1500, maxTargetMs: 4000, trialCount: 5 }),
  hard: Object.freeze({ minTargetMs: 500, maxTargetMs: 2200, trialCount: 5 }),
});

/**
 * FNV-1a: a small, well-known, dependency-free string hash. Only used to turn
 * an arbitrary seed string into a 32-bit integer for the PRNG below — it is
 * not cryptographic and must never be used for anything security-relevant.
 */
export function fnv1aHash(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * mulberry32: a small, fast, deterministic PRNG. Given the same 32-bit seed it
 * produces the same infinite sequence of floats in [0, 1) on every platform.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic UTC-day challenge key, independent of the player's local
 * timezone or clock. Two players anywhere in the world see the same key (and
 * therefore the same five targets) for the same UTC calendar day, even if
 * their local calendar day has already turned over.
 *
 * Contract: the key is `YYYY-MM-DD` of `date`'s UTC calendar day. Callers
 * that want "today" must pass `new Date()` — the UTC day is derived here, not
 * by the caller, so there is exactly one place this can drift.
 */
export function secondSenseDailyChallengeKey(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function secondSenseSeedForChallenge(
  mode: "practice" | "daily",
  input: { dailyKey?: string; practiceSeed?: string },
): string {
  if (mode === "daily") {
    if (!input.dailyKey) throw new Error("SECOND_SENSE_DAILY_KEY_REQUIRED");
    return `second-sense:daily:${input.dailyKey}`;
  }
  if (!input.practiceSeed) throw new Error("SECOND_SENSE_PRACTICE_SEED_REQUIRED");
  return `second-sense:practice:${input.practiceSeed}`;
}

/**
 * Generate the deterministic sequence of target hold durations (ms) for a
 * seed + difficulty. Pure function: same seed, same difficulty, same output,
 * every time.
 */
export function generateSecondSenseTargets(
  seed: string,
  difficulty: SecondSenseDifficulty,
): number[] {
  const config = SECOND_SENSE_DIFFICULTY_CONFIG[difficulty];
  const random = mulberry32(fnv1aHash(seed));
  const spread = config.maxTargetMs - config.minTargetMs;
  const targets: number[] = [];
  for (let index = 0; index < config.trialCount; index += 1) {
    const value = config.minTargetMs + Math.round(random() * spread);
    targets.push(value);
  }
  return targets;
}
