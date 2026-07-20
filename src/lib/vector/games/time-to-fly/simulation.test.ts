import { describe, expect, it } from "vitest";
import { TIME_TO_FLY_PHYSICS } from "@/lib/vector/games/time-to-fly/constants";
import {
  flyArrangement,
  launchState,
  placePlanets,
  stepCraft,
} from "@/lib/vector/games/time-to-fly/flight";
import { generateTimeToFlyLevel } from "@/lib/vector/games/time-to-fly/level";
import {
  initialRunState,
  rememberArrangement,
  solveLevel,
} from "@/lib/vector/games/time-to-fly/progress";
import {
  type TimeToFlySimulation,
  type TimeToFlyStepEvent,
  applyTimeToFlyInput,
  createTimeToFlySimulation,
  stepTimeToFlySimulation,
} from "@/lib/vector/games/time-to-fly/simulation";
import { verifyLevel } from "@/lib/vector/games/time-to-fly/verify";

const level = generateTimeToFlyLevel("sim-bridge", 1);
const solution = verifyLevel(level.planets, level.galaxy).solutions[0];

/** Step until the first non-launch event, collecting everything. */
function runFlight(start: TimeToFlySimulation): {
  simulation: TimeToFlySimulation;
  events: TimeToFlyStepEvent[];
  stepsTaken: number;
} {
  let simulation = start;
  const events: TimeToFlyStepEvent[] = [];
  for (let step = 0; step < TIME_TO_FLY_PHYSICS.MAX_FLIGHT_STEPS + 8; step += 1) {
    const result = stepTimeToFlySimulation(simulation);
    simulation = result.simulation;
    events.push(...result.events);
    if (events.some((event) => event.type !== "launch")) {
      return { simulation, events, stepsTaken: step + 1 };
    }
  }
  throw new Error("flight never resolved");
}

describe("bit-identity with the verifier's flight", () => {
  it("flies a verified solution to the identical arrival", () => {
    const reference = flyArrangement(level.planets, solution, level.galaxy);
    expect(reference.outcome).toBe("arrived");

    let simulation = createTimeToFlySimulation(initialRunState("run"), level);
    simulation = applyTimeToFlyInput(simulation, { type: "reset", arrangement: solution });
    simulation = applyTimeToFlyInput(simulation, { type: "launch" });
    const { simulation: done, events } = runFlight(simulation);

    const arrival = events.find((event) => event.type === "arrival");
    expect(arrival).toBeDefined();
    if (arrival?.type !== "arrival") throw new Error("unreachable");
    // Same flight, bit for bit: identical step count and closest approach.
    expect(arrival.steps).toBe(reference.steps);
    expect(done.closestApproach).toBe(reference.closestApproach);
    expect(done.run.solved[level.index]).toBe(true);
    expect(arrival.levelsSolved).toBe(1);
    expect(arrival.runCompleted).toBe(false);
  });

  it("advances the craft through the identical trajectory", () => {
    let simulation = createTimeToFlySimulation(initialRunState("run"), level);
    simulation = applyTimeToFlyInput(simulation, { type: "reset", arrangement: solution });
    simulation = applyTimeToFlyInput(simulation, { type: "launch" });
    // First step consumes the launch edge and places the craft.
    simulation = stepTimeToFlySimulation(simulation).simulation;

    // Reference chain: the exact calls flyArrangement makes.
    const placed = placePlanets(level.planets, solution);
    let reference = launchState();

    for (let step = 0; step < 200; step += 1) {
      simulation = stepTimeToFlySimulation(simulation).simulation;
      reference = stepCraft(reference, placed);
      expect(simulation.craft).not.toBeNull();
      // toEqual on the raw numbers: exact, not approximate.
      expect(simulation.craft?.position).toEqual(reference.position);
      expect(simulation.craft?.velocity).toEqual(reference.velocity);
    }
  });

  it("resolves a losing arrangement to the identical miss", () => {
    const reference = flyArrangement(level.planets, level.initialArrangement, level.galaxy);
    expect(reference.outcome).not.toBe("arrived");

    let simulation = createTimeToFlySimulation(initialRunState("run"), level);
    simulation = applyTimeToFlyInput(simulation, { type: "launch" });
    const { simulation: done, events } = runFlight(simulation);

    const miss = events.find((event) => event.type === "miss");
    expect(miss).toBeDefined();
    if (miss?.type !== "miss") throw new Error("unreachable");
    expect(miss.outcome).toBe(reference.outcome);
    expect(miss.crashedInto).toBe(reference.crashedInto);
    expect(done.closestApproach).toBe(reference.closestApproach);
  });
});

describe("launch and retry", () => {
  it("launches exactly once per request, no matter how long the key is held", () => {
    let simulation = createTimeToFlySimulation(initialRunState("run"), level);
    simulation = applyTimeToFlyInput(simulation, { type: "launch" });
    const first = stepTimeToFlySimulation(simulation);
    expect(first.events).toEqual([{ type: "launch", launches: 1 }]);
    // No new request: subsequent steps fly, they do not relaunch.
    const second = stepTimeToFlySimulation(first.simulation);
    expect(second.events).toEqual([]);
    expect(second.simulation.run.launches).toBe(1);
  });

  it("preserves the arrangement as launched across a miss, without lives or limits", () => {
    let simulation = createTimeToFlySimulation(initialRunState("run"), level);
    const launched = simulation.input.arrangement;
    simulation = applyTimeToFlyInput(simulation, { type: "launch" });
    const { simulation: afterMiss } = runFlight(simulation);

    // Back to aiming, board exactly as launched — ADR-0006's retry promise.
    expect(afterMiss.input.phase).toBe("aiming");
    expect(afterMiss.input.arrangement).toEqual(launched);
    expect(afterMiss.run.solved[level.index]).toBe(false);

    // And a second, third, fourth launch is always available.
    const again = applyTimeToFlyInput(afterMiss, { type: "launch" });
    const { simulation: secondMiss } = runFlight(again);
    expect(secondMiss.run.launches).toBe(2);
  });

  it("freezes the flown planets at launch even though input is locked", () => {
    let simulation = createTimeToFlySimulation(initialRunState("run"), level);
    simulation = applyTimeToFlyInput(simulation, { type: "launch" });
    simulation = stepTimeToFlySimulation(simulation).simulation;
    const placedAtLaunch = simulation.placed;
    // A drag attempt mid-flight must change neither the board nor the flight.
    simulation = applyTimeToFlyInput(simulation, {
      type: "dragStart",
      planetIndex: 0,
      offset: { x: 0, y: 40 },
    });
    simulation = stepTimeToFlySimulation(simulation).simulation;
    expect(simulation.placed).toBe(placedAtLaunch);
  });
});

describe("run accounting", () => {
  it("mirrors board edits into the run state for checkpointing", () => {
    let simulation = createTimeToFlySimulation(initialRunState("run"), level);
    simulation = applyTimeToFlyInput(simulation, { type: "rotateSelected", direction: 1 });
    expect(simulation.run.arrangement).toEqual(simulation.input.arrangement);
  });

  it("restores a remembered arrangement, and distrusts one of the wrong shape", () => {
    const remembered = rememberArrangement(initialRunState("run"), [7, 8]);
    const restored = createTimeToFlySimulation(remembered, level);
    expect(restored.input.arrangement).toEqual([7, 8]);

    const wrongShape = rememberArrangement(initialRunState("run"), [1, 2, 3, 4]);
    const fallback = createTimeToFlySimulation(wrongShape, level);
    expect(fallback.input.arrangement).toEqual(level.initialArrangement);
  });

  it("accrues fixed-step time while active and none after the run completes", () => {
    let simulation = createTimeToFlySimulation(initialRunState("run"), level);
    simulation = stepTimeToFlySimulation(simulation).simulation;
    expect(simulation.run.elapsedMs).toBe(TIME_TO_FLY_PHYSICS.FIXED_TIMESTEP_MS);

    let done = initialRunState("run");
    for (let index = 0; index < done.solved.length; index += 1) done = solveLevel(done, index);
    const inert = createTimeToFlySimulation(done, level);
    const result = stepTimeToFlySimulation(inert);
    expect(result.simulation).toBe(inert);
    expect(result.events).toEqual([]);
  });
});
