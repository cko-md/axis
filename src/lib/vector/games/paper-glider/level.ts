/**
 * Paper Glider room geometry — deterministic, pure, DOM-free.
 *
 * Rooms are GENERATED, never authored: "procedurally assembled rooms; no
 * external level dataset" is a binding acceptance criterion. A room is a
 * stretch of forward distance (z) between two openings (doorways) that the
 * glider must fly through; each room also carries interior furniture
 * obstacles and collectible rings.
 *
 * The one rule every other rule in this file serves: a generated flight must
 * always be flyable. Concretely — the drift between consecutive openings is
 * bounded by `physics.maxSteerableRadius`, called fresh at generation time
 * against the room's actual forward distance, not a second hand-tuned
 * constant that could quietly drift out of sync with the speed curve. See
 * `PAPER_GLIDER_LEVEL_CONFIG.OPENING_DRIFT_SAFETY_MARGIN` below and the
 * passability oracle tests, which fly the real step function through
 * generated rooms and prove it.
 */

import {
  type GliderPathSample,
  maxSteerableRadius,
  PAPER_GLIDER_PHYSICS,
  simulateGliderPath,
} from "@/lib/vector/games/paper-glider/physics";
import { createSeededRandom, randomInt, randomRange } from "@/lib/vector/games/paper-glider/rng";

export type PaperGliderOpening = Readonly<{
  /** 0 is the spawn gate; i is the far wall of room i. */
  index: number;
  x: number;
  y: number;
  halfWidth: number;
  halfHeight: number;
  z: number;
}>;

export type PaperGliderFurniture = Readonly<{
  x: number;
  y: number;
  z: number;
  halfX: number;
  halfY: number;
  halfZ: number;
}>;

export type PaperGliderRing = Readonly<{
  /** Index within this room only; combine with the room's index to identify it globally. */
  index: number;
  x: number;
  y: number;
  z: number;
}>;

export type PaperGliderRoom = Readonly<{
  /** 1-based. Room `n` spans from opening `n - 1` (entry) to opening `n` (exit). */
  index: number;
  entry: PaperGliderOpening;
  exit: PaperGliderOpening;
  furniture: readonly PaperGliderFurniture[];
  rings: readonly PaperGliderRing[];
}>;

export type PaperGliderLevel = Readonly<{
  seed: string;
  rooms: readonly PaperGliderRoom[];
}>;

export const PAPER_GLIDER_LEVEL_CONFIG = Object.freeze({
  /** Forward distance spanned by one room. */
  ROOM_DEPTH: 40,
  /** Room interior half-extents; a side-wall (not doorway) collision is anything outside these. */
  ROOM_HALF_WIDTH: 10,
  ROOM_HALF_HEIGHT: 8,
  /** Doorway half-extents. Both comfortably exceed HULL_RADIUS — see the config sanity test. */
  OPENING_HALF_WIDTH: 3.5,
  OPENING_HALF_HEIGHT: 3,
  /**
   * Detection tolerance for the wall-crossing check, in z units. Must exceed
   * PAPER_GLIDER_PHYSICS.SPEED_CAP: a fixed step can advance z by at most
   * SPEED_CAP, so if this were smaller than that, a single fast step could
   * cross an entire wall plane between two samples without ever registering
   * inside it — the exact tunnelling failure mode Brickrise's checkpoint
   * trigger test guards against. Enforced in level.test.ts.
   */
  WALL_THICKNESS_Z: 2,
  /**
   * Fraction of the physics-derived reachable radius actually used when
   * placing the next opening. Kept well under 1 so a real (imperfect) flight
   * has slack beyond the bare theoretical maximum — the oracle tests are what
   * validate this margin is large enough in practice; if they ever fail here,
   * the fix is either this margin or the generator, never the oracle.
   */
  OPENING_DRIFT_SAFETY_MARGIN: 0.55,

  FURNITURE_PER_ROOM_MAX: 3,
  /** Lateral/vertical half-extent of a furniture obstacle. */
  FURNITURE_HALF_SIZE_XY: 0.6,
  /**
   * Forward (z) half-extent of a furniture obstacle. Deliberately much larger
   * than FURNITURE_HALF_SIZE_XY: the same tunnelling argument as
   * WALL_THICKNESS_Z applies per-obstacle, so its full z-depth
   * (2 * FURNITURE_HALF_SIZE_Z) must exceed SPEED_CAP. Enforced in
   * level.test.ts.
   */
  FURNITURE_HALF_SIZE_Z: 1.6,
  FURNITURE_PLACEMENT_ATTEMPTS: 12,
  /** Furniture is never placed within this many z units of either doorway, so it cannot crowd a doorway's approach. */
  FURNITURE_Z_MARGIN: 6,
  /**
   * Extra clearance, beyond hull + furniture radii, kept between furniture
   * and the straight line connecting a room's entry and exit opening
   * centres. The real flown trajectory curves rather than following that
   * line exactly (steering is acceleration-limited, not instantaneous), so
   * this margin is sized to absorb that curvature and validated empirically
   * by the passability oracle tests — the same relationship this module
   * documents everywhere else, just proven by simulation rather than closed
   * form because the curvature has no simple closed form.
   */
  PATH_CLEARANCE_MARGIN: 1.2,

  RINGS_PER_ROOM_MIN: 1,
  RINGS_PER_ROOM_MAX: 3,
  RING_TRIGGER_RADIUS: 1,
});

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Position on a simulated flight path at forward distance z, interpolating
 * linearly between the two samples that bracket it (samples are one fixed
 * step apart, so linear interpolation between them is effectively exact).
 *
 * Deliberately NOT a straight line between the path's endpoints — see
 * `physics.simulateGliderPath`'s doc comment for why that distinction is the
 * whole point: real "arrive" steering can reach a room's target well before
 * its far wall and then fly level for the remainder, a shape a straight-line
 * interpolation does not capture and a furniture margin sized against it is
 * not safe against.
 */
function pathPositionAtZ(path: readonly GliderPathSample[], z: number): Readonly<{ x: number; y: number }> {
  const first = path[0];
  if (z <= first.z) return { x: first.x, y: first.y };
  const last = path[path.length - 1];
  if (z >= last.z) return { x: last.x, y: last.y };

  for (let i = 1; i < path.length; i += 1) {
    const sample = path[i];
    if (sample.z < z) continue;
    const previous = path[i - 1];
    const span = sample.z - previous.z;
    const t = span > 0 ? (z - previous.z) / span : 0;
    return { x: previous.x + (sample.x - previous.x) * t, y: previous.y + (sample.y - previous.y) * t };
  }
  return { x: last.x, y: last.y };
}

/** The furniture-to-flight-path clearance radius the generator enforces. Exported so tests verify it independently rather than trusting an internal flag. */
export function furnitureSafeTubeRadius(): number {
  const C = PAPER_GLIDER_LEVEL_CONFIG;
  return PAPER_GLIDER_PHYSICS.HULL_RADIUS + C.FURNITURE_HALF_SIZE_XY * Math.SQRT2 + C.PATH_CLEARANCE_MARGIN;
}

function generateFurniture(
  random: () => number,
  entry: PaperGliderOpening,
  exit: PaperGliderOpening,
  path: readonly GliderPathSample[],
): PaperGliderFurniture[] {
  const C = PAPER_GLIDER_LEVEL_CONFIG;
  const count = randomInt(random, 0, C.FURNITURE_PER_ROOM_MAX + 1);
  const safeTubeRadius = furnitureSafeTubeRadius();
  const items: PaperGliderFurniture[] = [];

  for (let i = 0; i < count; i += 1) {
    for (let attempt = 0; attempt < C.FURNITURE_PLACEMENT_ATTEMPTS; attempt += 1) {
      const z = randomRange(random, entry.z + C.FURNITURE_Z_MARGIN, exit.z - C.FURNITURE_Z_MARGIN);
      const x = randomRange(
        random,
        -C.ROOM_HALF_WIDTH + C.FURNITURE_HALF_SIZE_XY,
        C.ROOM_HALF_WIDTH - C.FURNITURE_HALF_SIZE_XY,
      );
      const y = randomRange(
        random,
        -C.ROOM_HALF_HEIGHT + C.FURNITURE_HALF_SIZE_XY,
        C.ROOM_HALF_HEIGHT - C.FURNITURE_HALF_SIZE_XY,
      );
      const flightPosition = pathPositionAtZ(path, z);
      const clearance = Math.hypot(x - flightPosition.x, y - flightPosition.y);
      if (clearance < safeTubeRadius) continue; // too close to the real flight path — resample rather than clamp into it

      items.push({
        x,
        y,
        z,
        halfX: C.FURNITURE_HALF_SIZE_XY,
        halfY: C.FURNITURE_HALF_SIZE_XY,
        halfZ: C.FURNITURE_HALF_SIZE_Z,
      });
      break;
      // If every attempt fails, this piece is simply not placed. Skipping is
      // always safe; inventing a spot that violates clearance is not.
    }
  }

  return items;
}

function generateRings(
  random: () => number,
  entry: PaperGliderOpening,
  exit: PaperGliderOpening,
  path: readonly GliderPathSample[],
): PaperGliderRing[] {
  const C = PAPER_GLIDER_LEVEL_CONFIG;
  const count = randomInt(random, C.RINGS_PER_ROOM_MIN, C.RINGS_PER_ROOM_MAX + 1);
  const rings: PaperGliderRing[] = [];

  for (let i = 0; i < count; i += 1) {
    // Evenly spread rather than clustered, and placed exactly on the
    // simulated flight path — a ring is provably reachable by construction
    // because it sits on the same path a real "arrive"-steered pursuit of
    // this room's exit actually flies, not an idealised straight line that
    // pursuit does not follow.
    const fraction = (i + 1) / (count + 1);
    const z = entry.z + fraction * (exit.z - entry.z);
    const position = pathPositionAtZ(path, z);
    rings.push({ index: i, x: position.x, y: position.y, z });
  }

  return rings;
}

/**
 * Generate one room, given the opening it starts from. Pure and
 * self-contained: everything about room `index` derives from `seed`, `index`,
 * and `entry` alone, which is what lets `extendPaperGliderLevel` append more
 * rooms later without replaying generation from the start.
 */
export function generatePaperGliderRoom(
  seed: string,
  index: number,
  entry: PaperGliderOpening,
): PaperGliderRoom {
  const C = PAPER_GLIDER_LEVEL_CONFIG;
  const random = createSeededRandom(`${seed}:room:${index}`);

  const zEnd = entry.z + C.ROOM_DEPTH;
  const reachableRadius = maxSteerableRadius(entry.z, C.ROOM_DEPTH);
  const bound = reachableRadius * C.OPENING_DRIFT_SAFETY_MARGIN;
  // A circle of radius `bound` sampled by independently clamping each axis:
  // clamping only ever SHRINKS a magnitude toward zero (both wall bounds
  // straddle zero because `entry` is itself always within them), so the
  // combined offset after clamping is still <= `bound`, never more. Sampling
  // a true random point in the disc and then clamping-to-wall would not have
  // this guarantee, since a wall clamp is an absolute-position operation.
  const halfBound = bound / Math.SQRT2;

  const wallHalfX = C.ROOM_HALF_WIDTH - C.OPENING_HALF_WIDTH;
  const wallHalfY = C.ROOM_HALF_HEIGHT - C.OPENING_HALF_HEIGHT;

  const rawDx = randomRange(random, -halfBound, halfBound);
  const rawDy = randomRange(random, -halfBound, halfBound);
  const dx = clamp(rawDx, -wallHalfX - entry.x, wallHalfX - entry.x);
  const dy = clamp(rawDy, -wallHalfY - entry.y, wallHalfY - entry.y);

  const exit: PaperGliderOpening = {
    index,
    x: entry.x + dx,
    y: entry.y + dy,
    halfWidth: C.OPENING_HALF_WIDTH,
    halfHeight: C.OPENING_HALF_HEIGHT,
    z: zEnd,
  };

  // The real path a pursuit of THIS exit actually flies, from THIS entry —
  // computed once and shared by furniture and ring placement below, rather
  // than each re-deriving (or worse, re-approximating) it separately.
  const path = simulateGliderPath(entry, exit);

  return {
    index,
    entry,
    exit,
    furniture: generateFurniture(random, entry, exit, path),
    rings: generateRings(random, entry, exit, path),
  };
}

export function spawnGate(): PaperGliderOpening {
  const C = PAPER_GLIDER_LEVEL_CONFIG;
  return { index: 0, x: 0, y: 0, halfWidth: C.OPENING_HALF_WIDTH, halfHeight: C.OPENING_HALF_HEIGHT, z: 0 };
}

/** Generate the first `roomCount` rooms for a seed. */
export function generatePaperGliderLevel(seed: string, roomCount: number): PaperGliderLevel {
  if (!Number.isInteger(roomCount) || roomCount < 1) {
    throw new Error("PAPER_GLIDER_ROOM_COUNT_INVALID");
  }

  const rooms: PaperGliderRoom[] = [];
  let entry = spawnGate();
  for (let index = 1; index <= roomCount; index += 1) {
    const room = generatePaperGliderRoom(seed, index, entry);
    rooms.push(room);
    entry = room.exit;
  }

  return { seed, rooms };
}

/**
 * Append `additionalRoomCount` more rooms after the level's current end.
 * Because each room derives purely from (seed, index, entry), this produces
 * exactly the rooms a single larger `generatePaperGliderLevel` call would
 * have — the flight is genuinely continuous, not chunked with a seam. This is
 * what lets the runtime simulation extend the level on the fly rather than
 * pre-generating an arbitrarily long one up front.
 */
export function extendPaperGliderLevel(level: PaperGliderLevel, additionalRoomCount: number): PaperGliderLevel {
  if (!Number.isInteger(additionalRoomCount) || additionalRoomCount < 1) return level;

  const lastRoom = level.rooms[level.rooms.length - 1];
  const startIndex = lastRoom ? lastRoom.index + 1 : 1;
  let entry = lastRoom ? lastRoom.exit : spawnGate();

  const appended: PaperGliderRoom[] = [];
  for (let i = 0; i < additionalRoomCount; i += 1) {
    const room = generatePaperGliderRoom(level.seed, startIndex + i, entry);
    appended.push(room);
    entry = room.exit;
  }

  return { ...level, rooms: [...level.rooms, ...appended] };
}

/** The room currently being traversed at forward distance z (the first room whose exit lies ahead of z). */
export function roomAtDistance(level: PaperGliderLevel, z: number): PaperGliderRoom {
  for (const room of level.rooms) {
    if (z < room.exit.z) return room;
  }
  return level.rooms[level.rooms.length - 1];
}

/** Is (x, y) inside the doorway, with the hull kept fully clear of its edges? */
export function isWithinOpening(x: number, y: number, opening: PaperGliderOpening, hullRadius: number): boolean {
  return (
    x >= opening.x - opening.halfWidth + hullRadius
    && x <= opening.x + opening.halfWidth - hullRadius
    && y >= opening.y - opening.halfHeight + hullRadius
    && y <= opening.y + opening.halfHeight - hullRadius
  );
}

/** Does the hull at (x, y, z) overlap this furniture box? */
export function collidesFurniture(
  x: number,
  y: number,
  z: number,
  box: PaperGliderFurniture,
  hullRadius: number,
): boolean {
  return (
    Math.abs(x - box.x) <= box.halfX + hullRadius
    && Math.abs(y - box.y) <= box.halfY + hullRadius
    && Math.abs(z - box.z) <= box.halfZ + hullRadius
  );
}

/** Has the hull at (x, y) left the room's open interior — a side-wall collision rather than a missed doorway? */
export function isOutsideRoomBounds(x: number, y: number, hullRadius: number): boolean {
  const C = PAPER_GLIDER_LEVEL_CONFIG;
  return Math.abs(x) > C.ROOM_HALF_WIDTH - hullRadius || Math.abs(y) > C.ROOM_HALF_HEIGHT - hullRadius;
}
