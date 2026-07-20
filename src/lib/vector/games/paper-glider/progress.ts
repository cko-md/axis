/**
 * Paper Glider run and score state — pure, DOM-free.
 *
 * Unlike Brickrise, a run here has no mid-flight checkpoint to resume:
 * `save.deterministicSeed` is false, and per the registry each run rolls a
 * fresh seed, so there is nothing meaningful to restore mid-run — a restart
 * always starts over. What DOES persist across runs is a personal best,
 * merged by the shared VECTOR contract's `Math.max` rule, which is the whole
 * of `PaperGliderSaveData` below.
 *
 * `PaperGliderRunState` is the ephemeral in-session state a single flight
 * accumulates; `mergeBest` folds a finished run into the cross-run save.
 */

export const PAPER_GLIDER_SAVE_SCHEMA_VERSION = 1;

export type PaperGliderCollisionReason = "wall" | "furniture" | "bounds";

export type PaperGliderRunState = Readonly<{
  seed: string;
  /** Forward distance flown this run. Monotonically non-decreasing. */
  distance: number;
  ringsCollected: number;
  /** `${roomIndex}:${ringIndex}` keys already banked, so a ring cannot be collected twice. */
  collectedRingKeys: readonly string[];
  alive: boolean;
  collisionReason: PaperGliderCollisionReason | null;
}>;

export function initialRunState(seed: string): PaperGliderRunState {
  return {
    seed,
    distance: 0,
    ringsCollected: 0,
    collectedRingKeys: [],
    alive: true,
    collisionReason: null,
  };
}

/** Identifies a ring uniquely across the whole level. */
export function ringCollectionKey(roomIndex: number, ringIndex: number): string {
  return `${roomIndex}:${ringIndex}`;
}

export const PAPER_GLIDER_SCORE = Object.freeze({
  /** Score points per world unit of forward distance flown — the dominant term, matching the "Longest flight" score label. */
  DISTANCE_PER_POINT: 1,
  /** Flat bonus per ring, sized so a deliberate detour is worth a clearly noticeable amount next to ordinary forward flight. */
  RING_BONUS: 25,
});

/** Score for a given distance and ring count. Both inputs only ever grow during a run, so the result never decreases mid-run. */
export function computeScore(distance: number, ringsCollected: number): number {
  const safeDistance = Number.isFinite(distance) ? Math.max(0, distance) : 0;
  const safeRings = Number.isFinite(ringsCollected) ? Math.max(0, Math.floor(ringsCollected)) : 0;
  return Math.round(safeDistance * PAPER_GLIDER_SCORE.DISTANCE_PER_POINT) + safeRings * PAPER_GLIDER_SCORE.RING_BONUS;
}

export function currentScore(state: PaperGliderRunState): number {
  return computeScore(state.distance, state.ringsCollected);
}

/** Record forward progress. A no-op once the run has ended, so a stray extra step after collision cannot inflate distance. */
export function advanceDistance(state: PaperGliderRunState, z: number): PaperGliderRunState {
  if (!state.alive || !Number.isFinite(z)) return state;
  return { ...state, distance: Math.max(state.distance, z) };
}

/** Record collecting a ring. Idempotent by key, so re-entering the same trigger volume across steps cannot double-count it. */
export function recordRingCollected(state: PaperGliderRunState, key: string): PaperGliderRunState {
  if (!state.alive || state.collectedRingKeys.includes(key)) return state;
  return {
    ...state,
    ringsCollected: state.ringsCollected + 1,
    collectedRingKeys: [...state.collectedRingKeys, key],
  };
}

/** End the run on collision. A no-op if the run has already ended, so the FIRST collision reason is the one that sticks. */
export function endRun(state: PaperGliderRunState, reason: PaperGliderCollisionReason): PaperGliderRunState {
  if (!state.alive) return state;
  return { ...state, alive: false, collisionReason: reason };
}

export type PaperGliderSaveData = Readonly<{
  version: number;
  bestScore: number;
  bestDistance: number;
  bestRingsCollected: number;
}>;

export function initialSaveData(): PaperGliderSaveData {
  return { version: PAPER_GLIDER_SAVE_SCHEMA_VERSION, bestScore: 0, bestDistance: 0, bestRingsCollected: 0 };
}

/** Fold a finished (or in-progress) run into the cross-run best, field-by-field maximum — the shared VECTOR merge rule. */
export function mergeBest(save: PaperGliderSaveData, run: PaperGliderRunState): PaperGliderSaveData {
  return {
    version: PAPER_GLIDER_SAVE_SCHEMA_VERSION,
    bestScore: Math.max(save.bestScore, currentScore(run)),
    bestDistance: Math.max(save.bestDistance, run.distance),
    bestRingsCollected: Math.max(save.bestRingsCollected, run.ringsCollected),
  };
}

/** Rehydrate a save. Returns null for anything unrecognised — a corrupt or future-versioned save must start from a fresh best, never a half-restored one. */
export function fromSaveData(raw: unknown): PaperGliderSaveData | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Partial<PaperGliderSaveData>;

  if (data.version !== PAPER_GLIDER_SAVE_SCHEMA_VERSION) return null;
  if (typeof data.bestScore !== "number" || !Number.isFinite(data.bestScore) || data.bestScore < 0) return null;
  if (typeof data.bestDistance !== "number" || !Number.isFinite(data.bestDistance) || data.bestDistance < 0) return null;
  if (
    typeof data.bestRingsCollected !== "number"
    || !Number.isFinite(data.bestRingsCollected)
    || data.bestRingsCollected < 0
  ) {
    return null;
  }

  return {
    version: PAPER_GLIDER_SAVE_SCHEMA_VERSION,
    bestScore: data.bestScore,
    bestDistance: data.bestDistance,
    bestRingsCollected: Math.floor(data.bestRingsCollected),
  };
}
