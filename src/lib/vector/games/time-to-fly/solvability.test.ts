import { describe, expect, it } from "vitest";
import {
  TIME_TO_FLY_ARENA,
  TIME_TO_FLY_LEVEL_COUNT,
} from "@/lib/vector/games/time-to-fly/constants";
import {
  type TimeToFlyLevel,
  generateTimeToFlyLevel,
} from "@/lib/vector/games/time-to-fly/level";
import {
  TIME_TO_FLY_FULL_PROTOCOL,
  TIME_TO_FLY_GATE_PROTOCOL,
  playerLaunchBudget,
  solveAsPlayer,
} from "@/lib/vector/games/time-to-fly/playerModel";
import { verifyLevel } from "@/lib/vector/games/time-to-fly/verify";

/**
 * THE BLOCKING SOLVABILITY-GRADIENT TEST — required by ADR-0006.
 *
 * Wave 15.8 shipped a tower with a floor 29 px beyond the maximum jump and 42
 * passing tests, because every test asserted floors were evenly SPACED and
 * none asserted one was REACHABLE. The equivalent failure here is a level
 * that is provably solvable — verify.ts counts its solutions exhaustively —
 * and humanly unsolvable, which is exactly what ADR-0006 measured the
 * rejected design producing (9/12 and 10/12 levels unsolved at four and five
 * planets under a 3000-launch budget).
 *
 * The reference player model lives in playerModel.ts and is BOTH the
 * generator's final acceptance gate (one systematic pass) and, here, the
 * regression guard: this test runs the FULL protocol — a strict superset of
 * the gate — against the real generator's output for named seeds. If the
 * gate is ever weakened or removed, or margins regress until solutions hide
 * at sub-slot precision, or fields stop being disjoint and the sector
 * gradient evaporates, this test fails. No amount of verifier-side proof can
 * satisfy it: the model only ever launches and watches, like a player.
 *
 * Budget calibration: the full protocol allows 2,184 launches at five
 * planets, closed-form from its own shape. ADR-0006's failure line is 3000
 * launches, and its accepted-design playability data measured a MEDIAN of
 * 867 launches at three planets.
 */
describe("solvability gradient (ADR-0006, blocking)", () => {
  const seeds = ["aurora", "meridian", "perigee"];

  for (const seed of seeds) {
    for (let index = 0; index < TIME_TO_FLY_LEVEL_COUNT; index += 1) {
      it(`a budgeted sector-by-sector player solves seed "${seed}" level ${index + 1}`, () => {
        const level = generateTimeToFlyLevel(seed, index);
        const result = solveAsPlayer(level, TIME_TO_FLY_FULL_PROTOCOL);
        expect(
          result.solved,
          `seed "${seed}" level ${index + 1}: player model exhausted `
            + `${result.launches}/${result.budget} launches without arriving; `
            + `chain progress ${result.bestProgress}/${level.planets.length} sectors, best `
            + `approach ${result.bestApproach.toFixed(1)} px — the level is provably `
            + `solvable but the gradient a player needs is gone`,
        ).toBe(true);
        expect(result.launches).toBeLessThanOrEqual(result.budget);
        // Regression-visibility: a level that BARELY solves is one tuning nudge
        // from not solving. The budget headroom is part of the assertion.
        expect(result.budget).toBeLessThanOrEqual(3000);
      });
    }
  }

  it("keeps the full protocol a strict superset of the generation gate", () => {
    // The gate's guarantee transfers to this test only because the full
    // protocol begins with the identical first round. If someone retunes one
    // protocol without the other, generated levels can pass the gate yet
    // fail here — this pins the relationship.
    expect(TIME_TO_FLY_FULL_PROTOCOL.rounds).toBeGreaterThanOrEqual(
      TIME_TO_FLY_GATE_PROTOCOL.rounds,
    );
    expect(TIME_TO_FLY_FULL_PROTOCOL.shortlist).toBe(TIME_TO_FLY_GATE_PROTOCOL.shortlist);
    expect(
      playerLaunchBudget(5, TIME_TO_FLY_FULL_PROTOCOL),
    ).toBeGreaterThanOrEqual(playerLaunchBudget(5, TIME_TO_FLY_GATE_PROTOCOL));
  });

  it("is not omniscient: an unsolvable level reports failure, within budget", () => {
    // Negative control: the model must be incapable of faking success. Take a
    // real level and move its galaxy BEHIND the launch pad. The craft departs
    // due east and the total turn capacity of a three-planet chain is under
    // 100 degrees, so no arrangement can ever head back west — verified by
    // the exhaustive search reporting zero solutions. The player model has to
    // come back empty-handed with its budget respected. If this ever
    // "solves", the model is consulting something a player cannot see.
    const source = generateTimeToFlyLevel("aurora", 2);
    const impossible: TimeToFlyLevel = {
      ...source,
      galaxy: { x: TIME_TO_FLY_ARENA.LAUNCH_X - 120, y: 120 },
      solutionCount: 0,
    };
    const verdict = verifyLevel(impossible.planets, impossible.galaxy);
    expect(verdict.exhausted).toBe(false);
    expect(verdict.solutions.length).toBe(0);

    const result = solveAsPlayer(impossible, TIME_TO_FLY_FULL_PROTOCOL);
    expect(result.solved).toBe(false);
    expect(result.launches).toBeLessThanOrEqual(result.budget);
  });
});
