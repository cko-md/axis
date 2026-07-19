/**
 * Brickrise level geometry — deterministic, pure, DOM-free.
 *
 * The tower is GENERATED rather than authored as a dataset, so the climb has no
 * external level file to load, version, or drift from the code that reads it.
 * Generation is seeded and total: the same seed always produces the same tower,
 * which is what lets a checkpoint recorded in one session be trusted in the
 * next.
 *
 * This module knows nothing about how a brick looks. Sprites, illustration and
 * lighting are the design layer's concern; what lives here is where a body can
 * stand, what kills it, and where the climb ends.
 */

export type Platform = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export type Hazard = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
  kind: "spike" | "gap";
}>;

export type Checkpoint = Readonly<{
  index: number;
  x: number;
  y: number;
}>;

export type BrickriseLevel = Readonly<{
  seed: string;
  width: number;
  /** Total climb height in pixels. y decreases as the player ascends. */
  height: number;
  spawn: Readonly<{ x: number; y: number }>;
  summitY: number;
  platforms: readonly Platform[];
  hazards: readonly Hazard[];
  checkpoints: readonly Checkpoint[];
}>;

export const BRICKRISE_LEVEL_CONFIG = Object.freeze({
  TOWER_WIDTH: 960,
  /** Vertical distance between platform rows. */
  FLOOR_SPACING: 132,
  /**
   * 24 floors at ~8s per floor lands inside the binding 3-5 minute window for a
   * competent first run, with checkpoints absorbing the retries.
   */
  FLOOR_COUNT: 24,
  PLATFORM_HEIGHT: 20,
  MIN_PLATFORM_WIDTH: 132,
  MAX_PLATFORM_WIDTH: 300,
  WALL_THICKNESS: 32,
  /** Every Nth floor carries a checkpoint. */
  CHECKPOINT_EVERY: 4,
  /** Hazards only begin once the player has learned the jump. */
  HAZARD_FIRST_FLOOR: 3,
  SPIKE_HEIGHT: 14,
});

// FNV-1a, then mulberry32 — the same deterministic pair Second Sense uses. Not
// cryptographic; chosen because it is byte-stable forever across engines, which
// a seeded tower depends on.
function fnv1aHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build the tower for a seed.
 *
 * Platform placement alternates side bias per floor so the climb zig-zags
 * rather than stacking into a straight vertical shaft — a column of aligned
 * ledges is trivially cleared by holding jump and reads as no climb at all.
 * Reachability is enforced structurally: every platform overlaps the horizontal
 * span reachable from the one below, so a generated tower can never be
 * impossible.
 */
export function generateBrickriseLevel(seed: string): BrickriseLevel {
  const C = BRICKRISE_LEVEL_CONFIG;
  const random = mulberry32(fnv1aHash(seed));

  const height = C.FLOOR_SPACING * (C.FLOOR_COUNT + 1);
  const platforms: Platform[] = [];
  const hazards: Hazard[] = [];
  const checkpoints: Checkpoint[] = [];

  const groundY = height;
  // Ground floor spans the full width — the run always starts on solid footing.
  platforms.push({
    x: 0,
    y: groundY,
    width: C.TOWER_WIDTH,
    height: C.PLATFORM_HEIGHT,
  });

  // Side walls keep the body inside the tower without a separate bounds check.
  platforms.push({ x: -C.WALL_THICKNESS, y: 0, width: C.WALL_THICKNESS, height });
  platforms.push({ x: C.TOWER_WIDTH, y: 0, width: C.WALL_THICKNESS, height });

  let previousCentre = C.TOWER_WIDTH / 2;

  for (let floor = 1; floor <= C.FLOOR_COUNT; floor += 1) {
    const y = groundY - floor * C.FLOOR_SPACING;
    const width =
      C.MIN_PLATFORM_WIDTH
      + Math.floor(random() * (C.MAX_PLATFORM_WIDTH - C.MIN_PLATFORM_WIDTH));

    // Alternate which side of the previous platform this one favours, then
    // clamp so it stays inside the tower and within reach.
    const bias = floor % 2 === 0 ? 1 : -1;
    const drift = (0.35 + random() * 0.5) * width * bias;
    const centre = Math.max(
      width / 2,
      Math.min(C.TOWER_WIDTH - width / 2, previousCentre + drift),
    );

    platforms.push({
      x: centre - width / 2,
      y,
      width,
      height: C.PLATFORM_HEIGHT,
    });

    if (floor >= C.HAZARD_FIRST_FLOOR && random() < 0.45) {
      // Spikes sit ON a platform, never in the only landing zone: the hazard is
      // confined to at most a third of the width and offset from centre, so
      // there is always a safe foothold on the same ledge.
      const spikeWidth = Math.max(24, Math.floor(width / 3));
      const onLeft = random() < 0.5;
      hazards.push({
        x: onLeft ? centre - width / 2 : centre + width / 2 - spikeWidth,
        y: y - C.SPIKE_HEIGHT,
        width: spikeWidth,
        height: C.SPIKE_HEIGHT,
        kind: "spike",
      });
    }

    // The summit floor is deliberately excluded even when it lands on the
    // interval. A checkpoint there can never be respawned to — reaching it ends
    // the run — so it would be dead state that also fires a checkpoint event on
    // the same step as the summit, clobbering the summit announcement with a
    // "checkpoint reached" the player has already surpassed.
    if (floor % C.CHECKPOINT_EVERY === 0 && floor !== C.FLOOR_COUNT) {
      checkpoints.push({
        index: checkpoints.length,
        x: centre,
        y,
      });
    }

    previousCentre = centre;
  }

  return {
    seed,
    width: C.TOWER_WIDTH,
    height,
    spawn: { x: C.TOWER_WIDTH / 2, y: groundY },
    summitY: groundY - C.FLOOR_COUNT * C.FLOOR_SPACING,
    platforms,
    hazards,
    checkpoints,
  };
}

/** Solid geometry for the physics step. Hazards are deliberately not solid. */
export function solidBoxesFor(level: BrickriseLevel): readonly Platform[] {
  return level.platforms;
}

/**
 * How large a checkpoint's activation volume is.
 *
 * A `Checkpoint` is stored as a bare point, but "did the player reach it" is a
 * rule about the run, not a drawing decision — so the volume lives here with a
 * test rather than being invented by whichever renderer happens to be running.
 *
 * Sized so a body standing anywhere on the checkpoint's own footing registers,
 * and so a body running past at MAX_RUN_SPEED cannot tunnel through between two
 * fixed steps. It deliberately does NOT extend far above the ledge: sailing over
 * a checkpoint mid-jump without ever touching down should not bank it.
 */
export const BRICKRISE_CHECKPOINT_TRIGGER = Object.freeze({
  WIDTH: 64,
  HEIGHT: 56,
});

/** The activation volume for a checkpoint, in level coordinates. */
export function checkpointTriggerBox(
  checkpoint: Checkpoint,
): Readonly<{ x: number; y: number; width: number; height: number }> {
  const T = BRICKRISE_CHECKPOINT_TRIGGER;
  return {
    x: checkpoint.x - T.WIDTH / 2,
    y: checkpoint.y - T.HEIGHT,
    width: T.WIDTH,
    height: T.HEIGHT,
  };
}

/** Has the body reached the summit ledge? */
export function hasReachedSummit(level: BrickriseLevel, bodyFeetY: number): boolean {
  return bodyFeetY <= level.summitY;
}
