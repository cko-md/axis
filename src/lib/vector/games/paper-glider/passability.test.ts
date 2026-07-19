import { describe, expect, it } from "vitest";
import {
  createPaperGliderSimulation,
  type PaperGliderSimulation,
  stepPaperGliderSimulation,
} from "@/lib/vector/games/paper-glider/simulation";
import { roomAtDistance } from "@/lib/vector/games/paper-glider/level";
import { ringCollectionKey } from "@/lib/vector/games/paper-glider/progress";

/**
 * The passability oracle — the heart of Wave 15.10.
 *
 * The 15.8 handoff's lesson: "two independently-tuned constants with nothing
 * relating them" is a defect class, and every remaining game wave must land a
 * reachability/solvability test that drives the REAL step function against
 * REAL generated content, not just check that two numbers agree on paper.
 *
 * Two autopilot policies fly the ACTUAL `stepPaperGliderSimulation` (the same
 * function a real run uses) through ACTUAL generated levels (the same
 * generator a real run uses):
 *
 *  - "reach": always steers toward the current room's exit centre. Proves the
 *    generator's opening-drift bound (level.ts, derived from
 *    physics.maxSteerableRadius) is honoured by the real dynamics, not just
 *    by the formula that produced it.
 *  - "rings": steers toward the nearest uncollected ring ahead, falling back
 *    to the exit. Proves rings are not just geometrically placed on a
 *    reachable line but actually collectible by a policy that has to divide
 *    its attention between rings and the doorway.
 *
 * If either oracle cannot clear the corpus, the fix is the GENERATOR (the
 * drift margin, the furniture clearance margin, the arrive-steering
 * constants) — never loosening what the oracle is asked to prove.
 */

const MIN_ROOMS = 30;
const MAX_STEPS = 8000;
const SEED_COUNT = 25;

type OracleResult = Readonly<{
  seed: string;
  roomsCleared: number;
  collided: boolean;
  collisionReason: string | null;
  ringsCollected: number;
  ringsAvailable: number;
}>;

function ringsAvailableThrough(sim: PaperGliderSimulation, roomsCleared: number): number {
  return sim.level.rooms.slice(0, roomsCleared).reduce((sum, room) => sum + room.rings.length, 0);
}

/** Autopilot that only ever aims at the current room's exit — the minimum policy needed to prove passability. */
function flyReachOracle(seed: string): OracleResult {
  let sim = createPaperGliderSimulation(seed);
  let roomsCleared = 0;
  let ringsCollected = 0;

  for (let step = 0; step < MAX_STEPS && roomsCleared < MIN_ROOMS; step += 1) {
    const room = roomAtDistance(sim.level, sim.body.z);
    const target = { x: room.exit.x, y: room.exit.y };
    const result = stepPaperGliderSimulation(sim, target);
    sim = result.simulation;

    for (const event of result.events) {
      if (event.type === "roomCleared") roomsCleared += 1;
      if (event.type === "ring") ringsCollected += 1;
      if (event.type === "collision") {
        return {
          seed,
          roomsCleared,
          collided: true,
          collisionReason: event.reason,
          ringsCollected,
          ringsAvailable: ringsAvailableThrough(sim, roomsCleared),
        };
      }
    }
  }

  return {
    seed,
    roomsCleared,
    collided: false,
    collisionReason: null,
    ringsCollected,
    ringsAvailable: ringsAvailableThrough(sim, roomsCleared),
  };
}

/** Autopilot that targets the nearest uncollected ring ahead in the current room, else the exit. */
function flyRingsOracle(seed: string): OracleResult {
  let sim = createPaperGliderSimulation(seed);
  let roomsCleared = 0;
  let ringsCollected = 0;

  for (let step = 0; step < MAX_STEPS && roomsCleared < MIN_ROOMS; step += 1) {
    const room = roomAtDistance(sim.level, sim.body.z);
    const nextRing = room.rings.find(
      (ring) => ring.z >= sim.body.z && !sim.run.collectedRingKeys.includes(ringCollectionKey(room.index, ring.index)),
    );
    const target = nextRing ? { x: nextRing.x, y: nextRing.y } : { x: room.exit.x, y: room.exit.y };
    const result = stepPaperGliderSimulation(sim, target);
    sim = result.simulation;

    for (const event of result.events) {
      if (event.type === "roomCleared") roomsCleared += 1;
      if (event.type === "ring") ringsCollected += 1;
      if (event.type === "collision") {
        return {
          seed,
          roomsCleared,
          collided: true,
          collisionReason: event.reason,
          ringsCollected,
          ringsAvailable: ringsAvailableThrough(sim, roomsCleared),
        };
      }
    }
  }

  return {
    seed,
    roomsCleared,
    collided: false,
    collisionReason: null,
    ringsCollected,
    ringsAvailable: ringsAvailableThrough(sim, roomsCleared),
  };
}

const SEEDS = Array.from({ length: SEED_COUNT }, (_, i) => `oracle-${i}`);

describe("passability oracle — reach mode", () => {
  it(`clears at least ${MIN_ROOMS} rooms without a single collision, across ${SEED_COUNT} seeds, including capped-speed depths`, () => {
    const results = SEEDS.map(flyReachOracle);
    for (const result of results) {
      expect(
        result.collided,
        `${result.seed}: collided (${result.collisionReason}) after clearing ${result.roomsCleared} rooms`,
      ).toBe(false);
      expect(
        result.roomsCleared,
        `${result.seed}: only cleared ${result.roomsCleared} of ${MIN_ROOMS} required rooms`,
      ).toBeGreaterThanOrEqual(MIN_ROOMS);
    }
  });
});

describe("passability oracle — ring collection mode", () => {
  it(`collects a high fraction of available rings while clearing ${MIN_ROOMS}+ rooms without collision`, () => {
    const results = SEEDS.map(flyRingsOracle);

    let totalCollected = 0;
    let totalAvailable = 0;
    for (const result of results) {
      expect(
        result.collided,
        `${result.seed}: collided (${result.collisionReason}) after clearing ${result.roomsCleared} rooms`,
      ).toBe(false);
      expect(result.roomsCleared).toBeGreaterThanOrEqual(MIN_ROOMS);
      totalCollected += result.ringsCollected;
      totalAvailable += result.ringsAvailable;
    }

    expect(totalAvailable).toBeGreaterThan(0);
    const fraction = totalCollected / totalAvailable;
    expect(fraction, `only collected ${(fraction * 100).toFixed(1)}% of ${totalAvailable} available rings`).toBeGreaterThan(0.9);
  });

  it("also clears a high fraction under the reach-only policy, since rings sit on the same path a doorway pursuit already flies", () => {
    // Not a requirement on its own — this is what makes the fraction
    // assertion above meaningful rather than accidental: rings are placed
    // exactly on the simulated path a doorway-only pursuit follows (see
    // level.ts's generateRings), so a reach-only policy is EXPECTED to
    // collect most of them too, just without deliberately reordering its
    // target between rings and the exit.
    const results = SEEDS.slice(0, 10).map(flyReachOracle);
    const collected = results.reduce((sum, r) => sum + r.ringsCollected, 0);
    const available = results.reduce((sum, r) => sum + r.ringsAvailable, 0);
    expect(available).toBeGreaterThan(0);
    expect(collected / available).toBeGreaterThan(0.85);
  });
});
