/**
 * Brickrise run progress and checkpoint persistence — pure, DOM-free.
 *
 * "Correct collision and checkpoint persistence" is a binding acceptance
 * criterion, so the rules that decide where a death sends you and what a saved
 * run means live here, apart from the renderer, and are tested directly.
 *
 * The invariant that matters: a checkpoint is a floor of progress, never a
 * ceiling. Reaching a lower checkpoint after a higher one must not move the
 * player backwards on their next death, or a run degrades as it continues.
 */

export const BRICKRISE_SAVE_SCHEMA_VERSION = 1;

export type BrickriseRunState = Readonly<{
  seed: string;
  /** Highest checkpoint index reached, or null before the first. */
  checkpointIndex: number | null;
  deaths: number;
  /** Accumulated elapsed play time, excluding paused time. */
  elapsedMs: number;
  completed: boolean;
}>;

export type BrickriseSaveData = Readonly<{
  version: number;
  seed: string;
  checkpointIndex: number | null;
  deaths: number;
  elapsedMs: number;
  completed: boolean;
}>;

export function initialRunState(seed: string): BrickriseRunState {
  return { seed, checkpointIndex: null, deaths: 0, elapsedMs: 0, completed: false };
}

/**
 * Record reaching a checkpoint. Monotonic by construction — see the invariant
 * above.
 */
export function reachCheckpoint(state: BrickriseRunState, index: number): BrickriseRunState {
  if (!Number.isInteger(index) || index < 0) return state;
  if (state.checkpointIndex !== null && index <= state.checkpointIndex) return state;
  return { ...state, checkpointIndex: index };
}

/** Record a death. Progress is retained; only the body respawns. */
export function recordDeath(state: BrickriseRunState): BrickriseRunState {
  return { ...state, deaths: state.deaths + 1 };
}

export function advanceElapsed(state: BrickriseRunState, deltaMs: number): BrickriseRunState {
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) return state;
  return { ...state, elapsedMs: state.elapsedMs + deltaMs };
}

export function completeRun(state: BrickriseRunState): BrickriseRunState {
  return { ...state, completed: true };
}

/**
 * Where a respawn puts the body: the highest checkpoint reached, else spawn.
 * Returning coordinates rather than an index keeps the renderer from having to
 * re-derive the mapping and get it subtly wrong.
 */
export function respawnPosition(
  state: BrickriseRunState,
  level: Readonly<{
    spawn: Readonly<{ x: number; y: number }>;
    checkpoints: readonly Readonly<{ index: number; x: number; y: number }>[];
  }>,
): Readonly<{ x: number; y: number }> {
  if (state.checkpointIndex === null) return level.spawn;
  const checkpoint = level.checkpoints.find((c) => c.index === state.checkpointIndex);
  // A saved index with no matching checkpoint means the save predates a level
  // change. Falling back to spawn is the safe direction: it costs progress,
  // where trusting it could place the body inside geometry.
  return checkpoint ? { x: checkpoint.x, y: checkpoint.y } : level.spawn;
}

export function toSaveData(state: BrickriseRunState): BrickriseSaveData {
  return {
    version: BRICKRISE_SAVE_SCHEMA_VERSION,
    seed: state.seed,
    checkpointIndex: state.checkpointIndex,
    deaths: state.deaths,
    elapsedMs: state.elapsedMs,
    completed: state.completed,
  };
}

/**
 * Rehydrate a save. Returns null for anything unrecognised — a corrupt or
 * future-versioned save must start a fresh run, never a half-restored one.
 */
export function fromSaveData(raw: unknown): BrickriseRunState | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Partial<BrickriseSaveData>;

  if (data.version !== BRICKRISE_SAVE_SCHEMA_VERSION) return null;
  if (typeof data.seed !== "string" || data.seed.length === 0) return null;
  if (typeof data.deaths !== "number" || !Number.isFinite(data.deaths) || data.deaths < 0) return null;
  if (typeof data.elapsedMs !== "number" || !Number.isFinite(data.elapsedMs) || data.elapsedMs < 0) return null;
  if (typeof data.completed !== "boolean") return null;

  const checkpointIndex = data.checkpointIndex;
  if (
    checkpointIndex !== null
    && (typeof checkpointIndex !== "number" || !Number.isInteger(checkpointIndex) || checkpointIndex < 0)
  ) {
    return null;
  }

  return {
    seed: data.seed,
    checkpointIndex: checkpointIndex ?? null,
    deaths: Math.floor(data.deaths),
    elapsedMs: data.elapsedMs,
    completed: data.completed,
  };
}

/**
 * Score for the shared VECTOR contract, which merges with Math.max — so a
 * faster summit must produce a LARGER number. Mirrors the ceiling transform
 * Second Sense uses for the same reason.
 */
export const BRICKRISE_SCORE_CEILING = 3_600_000;

export function toPersistedScore(elapsedMs: number): number {
  return Math.max(0, BRICKRISE_SCORE_CEILING - Math.round(elapsedMs));
}

export function fromPersistedScore(score: number): number {
  return Math.max(0, BRICKRISE_SCORE_CEILING - score);
}
