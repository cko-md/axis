/**
 * Time to Fly — the per-step orchestration, pure and DOM-free.
 *
 * flight.ts decides how the craft moves, level.ts decides what it flies
 * through, progress.ts decides what a run remembers, inputState.ts decides
 * what the player is asking for. This module is the fifth piece: the exact
 * ORDER those four are consulted in on a single fixed step, and what a step
 * reports back.
 *
 * It lives apart from the Phaser shell on purpose. The renderer is the one
 * part of this game that cannot be tested without a canvas, so everything
 * that decides what is true — including "is this in-shell flight the same
 * flight the verifier counted" — stays on this side of the boundary where a
 * test can reach it. Phaser draws the result; it never participates in
 * producing it.
 *
 * ── Bit-identity with the verifier ───────────────────────────────────────────
 * The in-flight branch below performs stepCraft plus the arrival, crash,
 * bounds and timeout checks in EXACTLY the order simulateFlight does
 * (flight.ts), because the verifier's flights are simulateFlight runs and the
 * player's flight must be the same flight, bit for bit. simulation.test.ts
 * drives both through a whole level and asserts identical outcomes, step
 * counts and final positions. Any reordering here is a correctness bug even
 * if every individual check is right.
 */

import {
  TIME_TO_FLY_ARENA,
  TIME_TO_FLY_PHYSICS,
} from "@/lib/vector/games/time-to-fly/constants";
import {
  type CraftState,
  type PlacedPlanet,
  launchState,
  placePlanets,
  stepCraft,
} from "@/lib/vector/games/time-to-fly/flight";
import type { TimeToFlyLevel } from "@/lib/vector/games/time-to-fly/level";
import {
  type TimeToFlyInputAction,
  type TimeToFlyInputState,
  createTimeToFlyInput,
  reduceTimeToFlyInput,
} from "@/lib/vector/games/time-to-fly/inputState";
import {
  type TimeToFlyRunState,
  advanceElapsed,
  recordLaunch,
  rememberArrangement,
  runCompleted,
  levelsSolvedCount,
  solveLevel,
} from "@/lib/vector/games/time-to-fly/progress";

/**
 * Things a step can report. The shell turns these into feedback, runtime
 * events and announcements; it is not allowed to re-derive them by diffing
 * state, which is how two surfaces drift apart.
 */
export type TimeToFlyStepEvent =
  | { type: "launch"; launches: number }
  | {
      type: "arrival";
      levelIndex: number;
      levelsSolved: number;
      runCompleted: boolean;
      steps: number;
    }
  | {
      type: "miss";
      outcome: "crashed" | "out-of-bounds" | "timeout";
      crashedInto: number | null;
      closestApproach: number;
    };

export type TimeToFlySimulation = Readonly<{
  level: TimeToFlyLevel;
  run: TimeToFlyRunState;
  input: TimeToFlyInputState;
  /** The craft in flight, or null while aiming. */
  craft: CraftState | null;
  /** Steps flown so far in the current flight. */
  flightSteps: number;
  /** Closest the current/last flight came to the galaxy, for feedback. */
  closestApproach: number;
  /**
   * Planet positions FROZEN at launch. The player can start a new drag the
   * moment the flight ends, but the flight that is in the air was launched
   * against exactly these positions and must finish against them.
   */
  placed: readonly PlacedPlanet[] | null;
}>;

/**
 * Build a simulation for a level. The board opens at the run's remembered
 * arrangement when one was saved mid-level, else at the level's seeded
 * opening — which is what makes suspend/restore invisible to the player.
 */
export function createTimeToFlySimulation(
  run: TimeToFlyRunState,
  level: TimeToFlyLevel,
): TimeToFlySimulation {
  const opening = run.arrangement ?? level.initialArrangement;
  // A remembered arrangement from a DIFFERENT level shape cannot be trusted.
  const arrangement = opening.length === level.planets.length ? opening : level.initialArrangement;
  return {
    level,
    run,
    input: createTimeToFlyInput(arrangement),
    craft: null,
    flightSteps: 0,
    closestApproach: Number.POSITIVE_INFINITY,
    placed: null,
  };
}

/**
 * Apply an input action without advancing time. Board changes are mirrored
 * into the run state immediately so that a checkpoint taken between frames
 * saves the planets where the player just put them.
 */
export function applyTimeToFlyInput(
  simulation: TimeToFlySimulation,
  action: TimeToFlyInputAction,
): TimeToFlySimulation {
  const input = reduceTimeToFlyInput(simulation.input, action);
  if (input === simulation.input) return simulation;
  const run =
    input.arrangement === simulation.input.arrangement
      ? simulation.run
      : rememberArrangement(simulation.run, input.arrangement);
  return { ...simulation, input, run };
}

export type TimeToFlyStepResult = Readonly<{
  simulation: TimeToFlySimulation;
  events: readonly TimeToFlyStepEvent[];
}>;

function distance(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Advance exactly one fixed step.
 *
 * A completed run is inert: elapsed time stops accruing the moment the last
 * level is solved, so a result left on screen does not quietly inflate the
 * persisted score.
 */
export function stepTimeToFlySimulation(simulation: TimeToFlySimulation): TimeToFlyStepResult {
  if (runCompleted(simulation.run)) return { simulation, events: [] };

  const events: TimeToFlyStepEvent[] = [];
  let { craft, flightSteps, closestApproach, placed, input, run } = simulation;

  const launchRequested = input.launchRequested && craft === null;
  // The edge lives exactly one step; consuming it here means a caller cannot
  // forget and launch on every frame the key stays down.
  input = reduceTimeToFlyInput(input, { type: "frame" });
  // Fixed, never wall-clock: a variable delta would make the persisted score
  // depend on the machine that produced it.
  run = advanceElapsed(run, TIME_TO_FLY_PHYSICS.FIXED_TIMESTEP_MS);

  if (launchRequested) {
    // The flight is flown against the arrangement as committed at this
    // instant; placePlanets is the exact resolution flyArrangement uses.
    placed = placePlanets(simulation.level.planets, input.arrangement);
    craft = launchState();
    flightSteps = 0;
    closestApproach = distance(
      craft.position.x,
      craft.position.y,
      simulation.level.galaxy.x,
      simulation.level.galaxy.y,
    );
    run = recordLaunch(run);
    input = reduceTimeToFlyInput(input, { type: "flightStarted" });
    events.push({ type: "launch", launches: run.launches });
    return { simulation: { ...simulation, craft, flightSteps, closestApproach, placed, input, run }, events };
  }

  if (craft !== null && placed !== null) {
    // One integrator step, then the checks in simulateFlight's exact order:
    // arrival, crash, bounds, timeout. See the module header for why the
    // order itself is load-bearing.
    craft = stepCraft(craft, placed);
    flightSteps += 1;

    const galaxy = simulation.level.galaxy;
    const toGalaxy = distance(craft.position.x, craft.position.y, galaxy.x, galaxy.y);
    if (toGalaxy < closestApproach) closestApproach = toGalaxy;

    if (toGalaxy <= TIME_TO_FLY_ARENA.GALAXY_RADIUS) {
      run = solveLevel(run, simulation.level.index);
      // The board is no longer meaningful for a solved level; the next level
      // opens at its own seeded arrangement.
      run = rememberArrangement(run, null);
      input = reduceTimeToFlyInput(input, { type: "flightEnded" });
      events.push({
        type: "arrival",
        levelIndex: simulation.level.index,
        levelsSolved: levelsSolvedCount(run),
        runCompleted: runCompleted(run),
        steps: flightSteps,
      });
      return {
        simulation: { ...simulation, craft: null, placed: null, flightSteps, closestApproach, input, run },
        events,
      };
    }

    for (const planet of placed) {
      if (
        distance(craft.position.x, craft.position.y, planet.position.x, planet.position.y)
        <= planet.bodyRadius + TIME_TO_FLY_PHYSICS.SHIP_RADIUS
      ) {
        input = reduceTimeToFlyInput(input, { type: "flightEnded" });
        events.push({ type: "miss", outcome: "crashed", crashedInto: planet.id, closestApproach });
        return {
          simulation: { ...simulation, craft: null, placed: null, flightSteps, closestApproach, input, run },
          events,
        };
      }
    }

    const margin = TIME_TO_FLY_ARENA.OUT_OF_BOUNDS_MARGIN;
    if (
      craft.position.x < -margin
      || craft.position.y < -margin
      || craft.position.x > TIME_TO_FLY_ARENA.WIDTH + margin
      || craft.position.y > TIME_TO_FLY_ARENA.HEIGHT + margin
    ) {
      input = reduceTimeToFlyInput(input, { type: "flightEnded" });
      events.push({ type: "miss", outcome: "out-of-bounds", crashedInto: null, closestApproach });
      return {
        simulation: { ...simulation, craft: null, placed: null, flightSteps, closestApproach, input, run },
        events,
      };
    }

    if (flightSteps >= TIME_TO_FLY_PHYSICS.MAX_FLIGHT_STEPS) {
      input = reduceTimeToFlyInput(input, { type: "flightEnded" });
      events.push({ type: "miss", outcome: "timeout", crashedInto: null, closestApproach });
      return {
        simulation: { ...simulation, craft: null, placed: null, flightSteps, closestApproach, input, run },
        events,
      };
    }
  }

  return { simulation: { ...simulation, craft, flightSteps, closestApproach, placed, input, run }, events };
}
