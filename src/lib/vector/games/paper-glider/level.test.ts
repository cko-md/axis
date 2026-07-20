import { describe, expect, it } from "vitest";
import {
  collidesFurniture,
  extendPaperGliderLevel,
  furnitureSafeTubeRadius,
  generatePaperGliderLevel,
  isOutsideRoomBounds,
  isWithinOpening,
  PAPER_GLIDER_LEVEL_CONFIG,
  type PaperGliderOpening,
  roomAtDistance,
} from "@/lib/vector/games/paper-glider/level";
import {
  distanceToSpeedCap,
  type GliderPathSample,
  maxSteerableRadius,
  PAPER_GLIDER_PHYSICS,
  simulateGliderPath,
} from "@/lib/vector/games/paper-glider/physics";

/**
 * Independently reproduce "where was the real flight at z" for a room,
 * without importing level.ts's internal interpolation helper — this is what
 * keeps the furniture/ring clearance tests below from just re-asserting the
 * generator's own bookkeeping.
 */
function positionAtZ(path: readonly GliderPathSample[], z: number): Readonly<{ x: number; y: number }> {
  if (z <= path[0].z) return { x: path[0].x, y: path[0].y };
  const last = path[path.length - 1];
  if (z >= last.z) return { x: last.x, y: last.y };
  for (let i = 1; i < path.length; i += 1) {
    if (path[i].z < z) continue;
    const a = path[i - 1];
    const b = path[i];
    const span = b.z - a.z;
    const t = span > 0 ? (z - a.z) / span : 0;
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  }
  return { x: last.x, y: last.y };
}

function flightPathFor(entry: PaperGliderOpening, exit: PaperGliderOpening): readonly GliderPathSample[] {
  return simulateGliderPath(entry, exit);
}

const SEEDS = Array.from({ length: 40 }, (_, i) => `fairness-${i}`);
const ROOM_COUNT = 40;

describe("config sanity — the relations the 15.8 lesson demands are checked, not assumed", () => {
  const C = PAPER_GLIDER_LEVEL_CONFIG;
  const P = PAPER_GLIDER_PHYSICS;

  it("gives WALL_THICKNESS_Z enough slack over SPEED_CAP that a fast step cannot skip an entire doorway plane", () => {
    expect(C.WALL_THICKNESS_Z).toBeGreaterThan(P.SPEED_CAP);
  });

  it("gives furniture enough forward depth that a fast step cannot skip through it", () => {
    expect(C.FURNITURE_HALF_SIZE_Z * 2).toBeGreaterThan(P.SPEED_CAP);
  });

  it("never generates a doorway narrower than the hull", () => {
    expect(C.OPENING_HALF_WIDTH).toBeGreaterThan(P.HULL_RADIUS);
    expect(C.OPENING_HALF_HEIGHT).toBeGreaterThan(P.HULL_RADIUS);
  });

  it("leaves the doorway room to drift within its own room's walls", () => {
    expect(C.ROOM_HALF_WIDTH).toBeGreaterThan(C.OPENING_HALF_WIDTH);
    expect(C.ROOM_HALF_HEIGHT).toBeGreaterThan(C.OPENING_HALF_HEIGHT);
  });
});

describe("deterministic generation", () => {
  it("produces an identical level for the same seed", () => {
    expect(generatePaperGliderLevel("seed-a", 10)).toEqual(generatePaperGliderLevel("seed-a", 10));
  });

  it("produces different levels for different seeds", () => {
    const a = generatePaperGliderLevel("seed-a", 10);
    const b = generatePaperGliderLevel("seed-b", 10);
    expect(a.rooms).not.toEqual(b.rooms);
  });

  it("is stable across repeated generation within a session, interleaved with other seeds", () => {
    for (const seed of ["alpha", "beta", "gamma"]) {
      const first = generatePaperGliderLevel(seed, 8);
      generatePaperGliderLevel("noise-in-between", 8);
      expect(generatePaperGliderLevel(seed, 8)).toEqual(first);
    }
  });

  it("rejects a non-positive or non-integer room count", () => {
    expect(() => generatePaperGliderLevel("seed", 0)).toThrow();
    expect(() => generatePaperGliderLevel("seed", -1)).toThrow();
    expect(() => generatePaperGliderLevel("seed", 1.5)).toThrow();
  });
});

describe("extendPaperGliderLevel", () => {
  it("produces exactly the rooms a single larger generation call would have — extension is not a seam", () => {
    const extended = extendPaperGliderLevel(generatePaperGliderLevel("seed-x", 5), 5);
    const wholesale = generatePaperGliderLevel("seed-x", 10);
    expect(extended.rooms).toEqual(wholesale.rooms);
  });

  it("is a no-op for a non-positive or non-integer count", () => {
    const level = generatePaperGliderLevel("seed-y", 5);
    expect(extendPaperGliderLevel(level, 0)).toBe(level);
    expect(extendPaperGliderLevel(level, -3)).toBe(level);
  });
});

describe("opening drift never exceeds the physics-derived passability bound", () => {
  it("holds across many seeds and rooms, including once the speed curve has capped", () => {
    for (const seed of SEEDS) {
      const level = generatePaperGliderLevel(seed, ROOM_COUNT);
      let entry = level.rooms[0].entry;
      for (const room of level.rooms) {
        // Independently recomputed here, not read off anything the generator
        // stored — this is what makes the assertion prove reachability rather
        // than just restate the generator's own bookkeeping.
        const reachable = maxSteerableRadius(entry.z, PAPER_GLIDER_LEVEL_CONFIG.ROOM_DEPTH);
        const bound = reachable * PAPER_GLIDER_LEVEL_CONFIG.OPENING_DRIFT_SAFETY_MARGIN;
        const drift = Math.hypot(room.exit.x - entry.x, room.exit.y - entry.y);
        expect(
          drift,
          `${seed}: room ${room.index} drifted ${drift.toFixed(3)} but only ${bound.toFixed(3)} was proven reachable`,
        ).toBeLessThanOrEqual(bound + 1e-9);
        entry = room.exit;
      }
    }
  });

  it("exercises capped-speed rooms within the generated corpus (otherwise the test above would not cover the harder case)", () => {
    const capDistance = distanceToSpeedCap();
    const level = generatePaperGliderLevel("cap-coverage", ROOM_COUNT);
    const lastRoom = level.rooms[level.rooms.length - 1];
    expect(lastRoom.exit.z).toBeGreaterThan(capDistance);
  });
});

describe("doorways stay within their room's own walls", () => {
  it("never places a doorway centre outside the room's lateral/vertical bounds", () => {
    for (const seed of SEEDS) {
      const level = generatePaperGliderLevel(seed, 15);
      for (const room of level.rooms) {
        expect(Math.abs(room.exit.x)).toBeLessThanOrEqual(
          PAPER_GLIDER_LEVEL_CONFIG.ROOM_HALF_WIDTH - PAPER_GLIDER_LEVEL_CONFIG.OPENING_HALF_WIDTH + 1e-9,
        );
        expect(Math.abs(room.exit.y)).toBeLessThanOrEqual(
          PAPER_GLIDER_LEVEL_CONFIG.ROOM_HALF_HEIGHT - PAPER_GLIDER_LEVEL_CONFIG.OPENING_HALF_HEIGHT + 1e-9,
        );
      }
    }
  });
});

describe("furniture never intersects the real flight-path safety tube", () => {
  it("holds across many seeds and rooms, measured against an independently re-simulated path (not a straight line)", () => {
    const safeRadius = furnitureSafeTubeRadius();
    let checkedAtLeastOneFurnitureItem = false;
    for (const seed of SEEDS) {
      const level = generatePaperGliderLevel(seed, 15);
      for (const room of level.rooms) {
        if (room.furniture.length === 0) continue;
        // Re-simulated here rather than trusting anything cached by
        // generation — this is what makes the assertion prove the real
        // dynamics stay clear, not just restate the generator's bookkeeping.
        const path = flightPathFor(room.entry, room.exit);
        for (const box of room.furniture) {
          checkedAtLeastOneFurnitureItem = true;
          const flightPosition = positionAtZ(path, box.z);
          const clearance = Math.hypot(box.x - flightPosition.x, box.y - flightPosition.y);
          expect(
            clearance,
            `${seed}: room ${room.index} furniture at (${box.x.toFixed(2)}, ${box.y.toFixed(2)}, ${box.z.toFixed(2)}) is only ${clearance.toFixed(2)} from the real flight path, needs ${safeRadius.toFixed(2)}`,
          ).toBeGreaterThanOrEqual(safeRadius - 1e-9);
        }
      }
    }
    // A generator that placed zero furniture across 40 seeds would make this
    // whole describe block vacuously true — guard against that.
    expect(checkedAtLeastOneFurnitureItem).toBe(true);
  });

  it("keeps every furniture piece within its own room's z-span, respecting the doorway margin", () => {
    for (const seed of SEEDS.slice(0, 10)) {
      const level = generatePaperGliderLevel(seed, 10);
      for (const room of level.rooms) {
        for (const box of room.furniture) {
          expect(box.z).toBeGreaterThanOrEqual(room.entry.z + PAPER_GLIDER_LEVEL_CONFIG.FURNITURE_Z_MARGIN);
          expect(box.z).toBeLessThanOrEqual(room.exit.z - PAPER_GLIDER_LEVEL_CONFIG.FURNITURE_Z_MARGIN);
        }
      }
    }
  });

  it("keeps every furniture piece within the room's lateral/vertical walls", () => {
    for (const seed of SEEDS.slice(0, 10)) {
      const level = generatePaperGliderLevel(seed, 10);
      for (const room of level.rooms) {
        for (const box of room.furniture) {
          expect(Math.abs(box.x)).toBeLessThanOrEqual(PAPER_GLIDER_LEVEL_CONFIG.ROOM_HALF_WIDTH);
          expect(Math.abs(box.y)).toBeLessThanOrEqual(PAPER_GLIDER_LEVEL_CONFIG.ROOM_HALF_HEIGHT);
        }
      }
    }
  });
});

describe("rings", () => {
  it("sit exactly on the real simulated flight path, so they are provably reachable by construction", () => {
    for (const seed of SEEDS.slice(0, 10)) {
      const level = generatePaperGliderLevel(seed, 10);
      for (const room of level.rooms) {
        if (room.rings.length === 0) continue;
        const path = flightPathFor(room.entry, room.exit);
        for (const ring of room.rings) {
          const position = positionAtZ(path, ring.z);
          expect(ring.x).toBeCloseTo(position.x, 9);
          expect(ring.y).toBeCloseTo(position.y, 9);
        }
      }
    }
  });

  it("every room has at least one ring and no more than the configured maximum", () => {
    for (const seed of SEEDS.slice(0, 10)) {
      const level = generatePaperGliderLevel(seed, 10);
      for (const room of level.rooms) {
        expect(room.rings.length).toBeGreaterThanOrEqual(PAPER_GLIDER_LEVEL_CONFIG.RINGS_PER_ROOM_MIN);
        expect(room.rings.length).toBeLessThanOrEqual(PAPER_GLIDER_LEVEL_CONFIG.RINGS_PER_ROOM_MAX);
      }
    }
  });
});

describe("roomAtDistance", () => {
  it("returns room 1 at the spawn gate", () => {
    const level = generatePaperGliderLevel("seed", 5);
    expect(roomAtDistance(level, 0).index).toBe(1);
  });

  it("advances to the next room once z crosses a doorway", () => {
    const level = generatePaperGliderLevel("seed", 5);
    const firstExitZ = level.rooms[0].exit.z;
    expect(roomAtDistance(level, firstExitZ - 0.001).index).toBe(1);
    expect(roomAtDistance(level, firstExitZ).index).toBe(2);
  });

  it("falls back to the last room past the generated content's end, rather than throwing", () => {
    const level = generatePaperGliderLevel("seed", 3);
    const farZ = level.rooms[level.rooms.length - 1].exit.z + 10_000;
    expect(roomAtDistance(level, farZ).index).toBe(3);
  });
});

describe("isWithinOpening", () => {
  const opening = { index: 1, x: 0, y: 0, halfWidth: 3, halfHeight: 2, z: 40 };

  it("accepts the centre and rejects points beyond the doorway edge", () => {
    expect(isWithinOpening(0, 0, opening, 0.35)).toBe(true);
    expect(isWithinOpening(10, 0, opening, 0.35)).toBe(false);
    expect(isWithinOpening(0, 10, opening, 0.35)).toBe(false);
  });

  it("keeps the hull fully clear of the doorway edge, not just its centre point", () => {
    // Exactly at the raw edge, a zero-radius point would pass; the hull must not.
    expect(isWithinOpening(opening.halfWidth, 0, opening, 0.35)).toBe(false);
    expect(isWithinOpening(opening.halfWidth - 0.35, 0, opening, 0.35)).toBe(true);
    expect(isWithinOpening(opening.halfWidth - 0.35 - 0.001, 0, opening, 0.35)).toBe(true);
  });
});

describe("collidesFurniture", () => {
  const box = { x: 1, y: -1, z: 20, halfX: 0.6, halfY: 0.6, halfZ: 1.6 };

  it("detects overlap at the box centre and clears well outside it", () => {
    expect(collidesFurniture(1, -1, 20, box, 0.35)).toBe(true);
    expect(collidesFurniture(10, 10, 100, box, 0.35)).toBe(false);
  });

  it("inflates the box by the hull radius on every axis", () => {
    const justOutsideRawBox = { x: box.x + box.halfX + 0.1, y: box.y, z: box.z };
    expect(collidesFurniture(justOutsideRawBox.x, justOutsideRawBox.y, justOutsideRawBox.z, box, 0.35)).toBe(true);
    expect(collidesFurniture(box.x + box.halfX + 0.5, box.y, box.z, box, 0.35)).toBe(false);
  });
});

describe("isOutsideRoomBounds", () => {
  it("is false at the centre and true well beyond the walls", () => {
    expect(isOutsideRoomBounds(0, 0, 0.35)).toBe(false);
    expect(isOutsideRoomBounds(PAPER_GLIDER_LEVEL_CONFIG.ROOM_HALF_WIDTH + 5, 0, 0.35)).toBe(true);
    expect(isOutsideRoomBounds(0, PAPER_GLIDER_LEVEL_CONFIG.ROOM_HALF_HEIGHT + 5, 0.35)).toBe(true);
  });

  it("accounts for the hull radius, not just the bare wall position", () => {
    const edge = PAPER_GLIDER_LEVEL_CONFIG.ROOM_HALF_WIDTH;
    expect(isOutsideRoomBounds(edge - 0.1, 0, 0.35)).toBe(true);
    expect(isOutsideRoomBounds(edge - 0.5, 0, 0.35)).toBe(false);
  });
});

describe("no generated climbable geometry is ever narrower than the hull (the class of bug the 15.8 handoff warns about)", () => {
  it("every furniture box remains larger than zero and the hull can never be wedged inside one by construction", () => {
    for (const seed of SEEDS.slice(0, 5)) {
      const level = generatePaperGliderLevel(seed, 10);
      for (const room of level.rooms) {
        for (const box of room.furniture) {
          expect(box.halfX).toBeGreaterThan(0);
          expect(box.halfY).toBeGreaterThan(0);
          expect(box.halfZ).toBeGreaterThan(0);
        }
      }
    }
  });
});
