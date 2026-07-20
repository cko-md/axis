/**
 * Time to Fly — run progress and persistence. Pure, DOM-free.
 *
 * A run is one deterministic seed and its five levels. What a run remembers is
 * deliberately small: which levels have been solved, how many launches it took,
 * how long it has been played, and the arrangement currently on the board —
 * because "retry preserves that level's randomized starting positions" and
 * "retry preserves the arrangement as launched" (ADR-0006) are both promises
 * about state that must survive a save/restore cycle, not just a session.
 *
 * The invariant that matters: solving a level is monotone. A later failed
 * launch, a reset, or a hydrate from an older save must never un-solve a level,
 * or a run degrades as it continues.
 */

import { TIME_TO_FLY_LEVEL_COUNT } from "@/lib/vector/games/time-to-fly/constants";
import type { TimeToFlyArrangement } from "@/lib/vector/games/time-to-fly/orbit";

/**
 * Must equal the manifest's saveSchemaVersion (registry.ts pins 1 for every
 * planned title) — the runtime rejects saves whose schemaVersion disagrees, so
 * drifting here silently deletes every player's progress.
 */
export const TIME_TO_FLY_SAVE_SCHEMA_VERSION = 1;

export type TimeToFlyRunState = Readonly<{
  /** The deterministic seed this run's five levels derive from. */
  runSeed: string;
  /** Which level the player is currently on, 0-based. */
  levelIndex: number;
  /** Solved flags per level, monotone — see the module invariant. */
  solved: readonly boolean[];
  /** Total launches across the run. Diagnostic and honest: no cap, no decay. */
  launches: number;
  /** Accumulated play time, excluding paused time. Fixed-step accounting. */
  elapsedMs: number;
  /**
   * The arrangement currently on the board for the current level, or null to
   * mean "open at the level's seeded initial arrangement". Persisted so a
   * suspend/restore cycle puts the planets back exactly where the player left
   * them mid-thought.
   */
  arrangement: TimeToFlyArrangement | null;
}>;

export function initialRunState(runSeed: string): TimeToFlyRunState {
  return {
    runSeed,
    levelIndex: 0,
    solved: Array.from({ length: TIME_TO_FLY_LEVEL_COUNT }, () => false),
    launches: 0,
    elapsedMs: 0,
    arrangement: null,
  };
}

export function runCompleted(state: TimeToFlyRunState): boolean {
  return state.solved.every(Boolean);
}

export function levelsSolvedCount(state: TimeToFlyRunState): number {
  return state.solved.reduce((count, solved) => count + (solved ? 1 : 0), 0);
}

/** Record a launch. No lives, no retry limit — the count only ever grows. */
export function recordLaunch(state: TimeToFlyRunState): TimeToFlyRunState {
  return { ...state, launches: state.launches + 1 };
}

export function advanceElapsed(state: TimeToFlyRunState, deltaMs: number): TimeToFlyRunState {
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) return state;
  return { ...state, elapsedMs: state.elapsedMs + deltaMs };
}

/**
 * Mark a level solved. Monotone by construction: solving an already-solved
 * level is a no-op, and no operation in this module clears a flag.
 */
export function solveLevel(state: TimeToFlyRunState, levelIndex: number): TimeToFlyRunState {
  if (!Number.isInteger(levelIndex) || levelIndex < 0 || levelIndex >= state.solved.length) {
    return state;
  }
  if (state.solved[levelIndex]) return state;
  const solved = state.solved.map((flag, index) => (index === levelIndex ? true : flag));
  return { ...state, solved };
}

/**
 * Move to a level. The board arrangement is cleared to null — each level owns
 * its seeded opening, and carrying slots across levels would be nonsense.
 */
export function selectLevel(state: TimeToFlyRunState, levelIndex: number): TimeToFlyRunState {
  if (!Number.isInteger(levelIndex) || levelIndex < 0 || levelIndex >= state.solved.length) {
    return state;
  }
  if (levelIndex === state.levelIndex) return state;
  return { ...state, levelIndex, arrangement: null };
}

/** Record where the planets sit right now, so a restore is exact. */
export function rememberArrangement(
  state: TimeToFlyRunState,
  arrangement: TimeToFlyArrangement | null,
): TimeToFlyRunState {
  return { ...state, arrangement: arrangement ? [...arrangement] : null };
}

export type TimeToFlySaveData = Readonly<{
  version: number;
  runSeed: string;
  levelIndex: number;
  solved: readonly boolean[];
  launches: number;
  elapsedMs: number;
  arrangement: readonly number[] | null;
}>;

export function toSaveData(state: TimeToFlyRunState): TimeToFlySaveData {
  return {
    version: TIME_TO_FLY_SAVE_SCHEMA_VERSION,
    runSeed: state.runSeed,
    levelIndex: state.levelIndex,
    solved: [...state.solved],
    launches: state.launches,
    elapsedMs: state.elapsedMs,
    arrangement: state.arrangement ? [...state.arrangement] : null,
  };
}

/**
 * Rehydrate a save. Returns null for anything unrecognised — a corrupt or
 * future-versioned save must start a fresh run, never a half-restored one.
 */
export function fromSaveData(raw: unknown): TimeToFlyRunState | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Partial<TimeToFlySaveData>;

  if (data.version !== TIME_TO_FLY_SAVE_SCHEMA_VERSION) return null;
  if (typeof data.runSeed !== "string" || data.runSeed.length === 0) return null;
  if (
    !Number.isInteger(data.levelIndex)
    || (data.levelIndex as number) < 0
    || (data.levelIndex as number) >= TIME_TO_FLY_LEVEL_COUNT
  ) {
    return null;
  }
  if (
    !Array.isArray(data.solved)
    || data.solved.length !== TIME_TO_FLY_LEVEL_COUNT
    || data.solved.some((flag) => typeof flag !== "boolean")
  ) {
    return null;
  }
  if (typeof data.launches !== "number" || !Number.isFinite(data.launches) || data.launches < 0) return null;
  if (typeof data.elapsedMs !== "number" || !Number.isFinite(data.elapsedMs) || data.elapsedMs < 0) return null;

  const arrangement = data.arrangement;
  if (arrangement !== null && arrangement !== undefined) {
    if (
      !Array.isArray(arrangement)
      || arrangement.some((slot) => !Number.isInteger(slot) || slot < 0 || slot >= 12)
    ) {
      return null;
    }
  }

  return {
    runSeed: data.runSeed,
    levelIndex: data.levelIndex as number,
    solved: [...data.solved] as boolean[],
    launches: Math.floor(data.launches),
    elapsedMs: data.elapsedMs,
    arrangement: arrangement ? [...arrangement] : null,
  };
}

/**
 * Score for the shared VECTOR contract, which merges with Math.max — so MORE
 * levels solved must always beat FEWER, and within the same solved count a
 * FASTER run must produce a LARGER number. Levels dominate lexicographically:
 * the per-level stride exceeds the largest possible time bonus, so no amount
 * of speed on four levels outranks a slow five.
 */
export const TIME_TO_FLY_SCORE_STRIDE = 10_000_000;
export const TIME_TO_FLY_TIME_CEILING = 3_600_000;

export function toPersistedScore(state: TimeToFlyRunState): number {
  const solved = levelsSolvedCount(state);
  const bonus = Math.max(0, TIME_TO_FLY_TIME_CEILING - Math.round(state.elapsedMs));
  return solved * TIME_TO_FLY_SCORE_STRIDE + bonus;
}

/** Read a persisted score back into its parts, for display. */
export function fromPersistedScore(score: number): Readonly<{ levelsSolved: number; elapsedMs: number }> {
  const clamped = Math.max(0, Math.round(score));
  const levelsSolved = Math.min(
    TIME_TO_FLY_LEVEL_COUNT,
    Math.floor(clamped / TIME_TO_FLY_SCORE_STRIDE),
  );
  const bonus = Math.min(TIME_TO_FLY_TIME_CEILING, clamped - levelsSolved * TIME_TO_FLY_SCORE_STRIDE);
  return { levelsSolved, elapsedMs: TIME_TO_FLY_TIME_CEILING - bonus };
}
