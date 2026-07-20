/**
 * Paper Glider simulation — the per-step orchestration, pure and DOM-free.
 *
 * physics.ts decides how the glider moves, level.ts decides what it flies
 * through, progress.ts decides what a run remembers. This module is the
 * fourth piece: the exact order those three are consulted in on a single
 * fixed step, and what a step reports back — mirroring Brickrise's
 * simulation.ts split for the same reason. Everything that decides what is
 * true (did this doorway get missed, did a ring get collected, did the run
 * just end) lives on this side of the boundary where a test can reach it
 * without a WebGL context. The Three.js shell (a separate wave) draws the
 * result; it never participates in producing it.
 *
 * The level is generated lazily and extended as the glider approaches its
 * end (see PAPER_GLIDER_RUNTIME below), so a flight is genuinely continuous
 * rather than a fixed-length run through a pre-baked room count.
 */

import {
  type GliderState,
  INITIAL_GLIDER_STATE,
  PAPER_GLIDER_PHYSICS,
  type SteerTarget,
  stepGlider,
} from "@/lib/vector/games/paper-glider/physics";
import {
  collidesFurniture,
  extendPaperGliderLevel,
  generatePaperGliderLevel,
  isOutsideRoomBounds,
  isWithinOpening,
  type PaperGliderLevel,
  type PaperGliderRoom,
  PAPER_GLIDER_LEVEL_CONFIG,
  roomAtDistance,
} from "@/lib/vector/games/paper-glider/level";
import {
  advanceDistance,
  currentScore,
  endRun,
  initialRunState,
  type PaperGliderCollisionReason,
  type PaperGliderRunState,
  recordRingCollected,
  ringCollectionKey,
} from "@/lib/vector/games/paper-glider/progress";

export type PaperGliderStepEvent =
  | { type: "roomCleared"; roomIndex: number }
  | { type: "ring"; roomIndex: number; ringIndex: number; total: number }
  | { type: "collision"; reason: PaperGliderCollisionReason; distance: number; score: number };

export type PaperGliderSimulation = Readonly<{
  level: PaperGliderLevel;
  body: GliderState;
  run: PaperGliderRunState;
}>;

export type PaperGliderStepResult = Readonly<{
  simulation: PaperGliderSimulation;
  events: readonly PaperGliderStepEvent[];
}>;

export const PAPER_GLIDER_RUNTIME = Object.freeze({
  /** Rooms generated up front when a run starts. */
  INITIAL_ROOM_COUNT: 12,
  /** Rooms appended each time the level needs extending. */
  EXTEND_BATCH: 8,
  /**
   * Extend once fewer than this many rooms' worth of forward distance remains
   * ahead of the glider. Comfortably larger than one room so extension always
   * completes well before the glider could possibly reach the generated
   * content's actual end, regardless of speed.
   */
  EXTEND_THRESHOLD_ROOMS: 3,
});

/** Start a fresh run. `seed` is the caller's responsibility to generate anew each time — see the registry's `deterministicSeed: false`: a restart is a new seed, never a re-roll of the last one. */
export function createPaperGliderSimulation(seed: string): PaperGliderSimulation {
  const level = generatePaperGliderLevel(seed, PAPER_GLIDER_RUNTIME.INITIAL_ROOM_COUNT);
  return { level, body: INITIAL_GLIDER_STATE, run: initialRunState(seed) };
}

function ensureRoomsAhead(level: PaperGliderLevel, z: number): PaperGliderLevel {
  const R = PAPER_GLIDER_RUNTIME;
  const lastRoom = level.rooms[level.rooms.length - 1];
  const remainingDepth = lastRoom.exit.z - z;
  if (remainingDepth < R.EXTEND_THRESHOLD_ROOMS * PAPER_GLIDER_LEVEL_CONFIG.ROOM_DEPTH) {
    return extendPaperGliderLevel(level, R.EXTEND_BATCH);
  }
  return level;
}

function findFirstCollidingFurniture(
  room: PaperGliderRoom,
  body: GliderState,
): PaperGliderRoom["furniture"][number] | undefined {
  return room.furniture.find((box) => collidesFurniture(body.x, body.y, body.z, box, PAPER_GLIDER_PHYSICS.HULL_RADIUS));
}

/**
 * Advance exactly one fixed step.
 *
 * An ended run is inert — no further movement, collection, or events — so a
 * caller that keeps stepping after a collision cannot inflate distance or
 * score, and `run` in the returned simulation stays byte-identical.
 */
export function stepPaperGliderSimulation(
  simulation: PaperGliderSimulation,
  target: SteerTarget,
): PaperGliderStepResult {
  if (!simulation.run.alive) return { simulation, events: [] };

  const level = ensureRoomsAhead(simulation.level, simulation.body.z);
  const prevZ = simulation.body.z;
  const prevRoom = roomAtDistance(level, prevZ);

  const body = stepGlider(simulation.body, target);
  const events: PaperGliderStepEvent[] = [];
  let run = advanceDistance(simulation.run, body.z);

  // A single fixed step can advance z by at most SPEED_CAP, which is smaller
  // than WALL_THICKNESS_Z (see level.ts), so at most one wall plane is ever
  // relevant to a single step — no risk of skipping a doorway check entirely.
  const crossedExit = prevZ < prevRoom.exit.z && body.z >= prevRoom.exit.z;
  if (crossedExit && !isWithinOpening(body.x, body.y, prevRoom.exit, PAPER_GLIDER_PHYSICS.HULL_RADIUS)) {
    run = endRun(run, "wall");
    events.push({ type: "collision", reason: "wall", distance: run.distance, score: currentScore(run) });
    return { simulation: { level, body, run }, events };
  }
  if (crossedExit) {
    events.push({ type: "roomCleared", roomIndex: prevRoom.index });
  }

  const currentRoom = roomAtDistance(level, body.z);

  const hitFurniture = findFirstCollidingFurniture(currentRoom, body);
  if (hitFurniture) {
    run = endRun(run, "furniture");
    events.push({ type: "collision", reason: "furniture", distance: run.distance, score: currentScore(run) });
    return { simulation: { level, body, run }, events };
  }

  if (isOutsideRoomBounds(body.x, body.y, PAPER_GLIDER_PHYSICS.HULL_RADIUS)) {
    run = endRun(run, "bounds");
    events.push({ type: "collision", reason: "bounds", distance: run.distance, score: currentScore(run) });
    return { simulation: { level, body, run }, events };
  }

  const captureRadius = PAPER_GLIDER_LEVEL_CONFIG.RING_TRIGGER_RADIUS + PAPER_GLIDER_PHYSICS.HULL_RADIUS;
  // Squared-distance comparison, never Math.hypot: hypot is not required to be
  // correctly rounded, and this check runs on the authoritative per-step path,
  // where every operation must be bit-identical across JS engines (the
  // determinism rule — only + - * / and sqrt). Squaring both sides needs no
  // root at all.
  const captureRadiusSquared = captureRadius * captureRadius;
  for (const ring of currentRoom.rings) {
    const key = ringCollectionKey(currentRoom.index, ring.index);
    if (run.collectedRingKeys.includes(key)) continue;
    const ringDx = body.x - ring.x;
    const ringDy = body.y - ring.y;
    const ringDz = body.z - ring.z;
    if (ringDx * ringDx + ringDy * ringDy + ringDz * ringDz <= captureRadiusSquared) {
      run = recordRingCollected(run, key);
      events.push({ type: "ring", roomIndex: currentRoom.index, ringIndex: ring.index, total: currentRoom.rings.length });
    }
  }

  return { simulation: { level, body, run }, events };
}
