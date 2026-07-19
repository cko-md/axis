import { describe, expect, it } from "vitest";
import {
  TIME_TO_FLY_ARENA,
  TIME_TO_FLY_LEVEL_COUNT,
} from "@/lib/vector/games/time-to-fly/constants";
import { flyArrangement } from "@/lib/vector/games/time-to-fly/flight";
import {
  TIME_TO_FLY_ACCEPTANCE,
  generateTimeToFlyLevel,
  generateTimeToFlyRun,
} from "@/lib/vector/games/time-to-fly/level";
import {
  allFieldsDisjoint,
  pointOutsideReach,
} from "@/lib/vector/games/time-to-fly/orbit";
import { verifyLevel } from "@/lib/vector/games/time-to-fly/verify";

/**
 * Named seeds, exercised in full. Generation is deterministic, so these are
 * not samples of a distribution — they are the exact levels those seeds will
 * always produce, and every acceptance property is asserted on each.
 */
const SEEDS = ["aurora", "meridian"];

describe("deterministic seeding", () => {
  it("produces bit-identical levels for the same seed", () => {
    for (let index = 0; index < TIME_TO_FLY_LEVEL_COUNT; index += 1) {
      const first = generateTimeToFlyLevel("stability", index);
      const second = generateTimeToFlyLevel("stability", index);
      // Not "close to" — identical, via exact serialisation. A seed is a
      // promise that the same five levels come back forever.
      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    }
  });

  it("produces different levels for different seeds", () => {
    const a = generateTimeToFlyLevel("seed-a", 0);
    const b = generateTimeToFlyLevel("seed-b", 0);
    expect(JSON.stringify(a.planets)).not.toBe(JSON.stringify(b.planets));
  });

  it("rejects an out-of-range level index", () => {
    expect(() => generateTimeToFlyLevel("x", -1)).toThrow(/OUT_OF_RANGE/);
    expect(() => generateTimeToFlyLevel("x", TIME_TO_FLY_LEVEL_COUNT)).toThrow(/OUT_OF_RANGE/);
    expect(() => generateTimeToFlyLevel("x", 1.5)).toThrow(/OUT_OF_RANGE/);
  });

  it("generates a full five-level run", () => {
    const run = generateTimeToFlyRun(SEEDS[0]);
    expect(run).toHaveLength(TIME_TO_FLY_LEVEL_COUNT);
    run.forEach((level, index) => {
      expect(level.index).toBe(index);
      // The binding spec: level N contains N planets.
      expect(level.planets).toHaveLength(index + 1);
    });
  });
});

describe("acceptance invariants on generated levels", () => {
  for (const seed of SEEDS) {
    for (let index = 0; index < TIME_TO_FLY_LEVEL_COUNT; index += 1) {
      it(`hold for seed "${seed}" level ${index + 1}`, () => {
        const level = generateTimeToFlyLevel(seed, index);
        const A = TIME_TO_FLY_ACCEPTANCE;

        // Disjoint reach discs: the ADR-0006 invariant everything rests on.
        expect(allFieldsDisjoint(level.planets, A.DISC_CLEARANCE)).toBe(true);

        // Neither endpoint of the flight sits inside anyone's gravity.
        const launch = { x: TIME_TO_FLY_ARENA.LAUNCH_X, y: TIME_TO_FLY_ARENA.LAUNCH_Y };
        for (const planet of level.planets) {
          expect(pointOutsideReach(planet, launch, A.DISC_CLEARANCE)).toBe(true);
          expect(pointOutsideReach(planet, level.galaxy, A.DISC_CLEARANCE)).toBe(true);
        }

        // The solution count gate, re-proven rather than trusted.
        const verdict = verifyLevel(level.planets, level.galaxy);
        expect(verdict.exhausted).toBe(false);
        expect(verdict.solutions.length).toBe(level.solutionCount);
        expect(level.solutionCount).toBeGreaterThanOrEqual(A.MIN_SOLUTIONS);
        expect(level.solutionCount).toBeLessThanOrEqual(A.MAX_SOLUTIONS);

        // Every verified solution must be flyable by the player's own code
        // path — the bridge that makes the count a statement about the game.
        for (const solution of verdict.solutions) {
          expect(flyArrangement(level.planets, solution, level.galaxy).outcome).toBe("arrived");
        }

        // The level opens UNSOLVED: its seeded starting arrangement loses.
        const opening = flyArrangement(level.planets, level.initialArrangement, level.galaxy);
        expect(
          opening.outcome,
          `seed "${seed}" level ${index + 1} opens already solved`,
        ).not.toBe("arrived");

        // The margin gates, re-proven: the best solution is aimed well inside
        // the galaxy, and no losing branch misses by a hair the player
        // cannot see.
        expect(verdict.bestAim).toBeLessThanOrEqual(
          TIME_TO_FLY_ARENA.GALAXY_RADIUS * A.CLEAN_ARRIVAL,
        );
        expect(verdict.nearestMiss).toBeGreaterThanOrEqual(
          TIME_TO_FLY_ARENA.GALAXY_RADIUS * A.MISS_MARGIN,
        );
      });
    }
  }
});
