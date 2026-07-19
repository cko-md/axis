import { describe, expect, it } from "vitest";
import {
  type BrickriseSimulation,
  applyBrickriseInput,
  createBrickriseSimulation,
  stepBrickriseSimulation,
} from "@/lib/vector/games/brickrise/simulation";
import { BRICKRISE_PHYSICS, INITIAL_BODY_STATE, placeBodyAt } from "@/lib/vector/games/brickrise/physics";
import { type BrickriseLevel, generateBrickriseLevel } from "@/lib/vector/games/brickrise/level";
import { initialRunState, reachCheckpoint } from "@/lib/vector/games/brickrise/progress";
import { INITIAL_BRICKRISE_INPUT } from "@/lib/vector/games/brickrise/inputState";

/**
 * A deliberately tiny hand-built tower. Generated levels are exercised at the
 * bottom for determinism, but every rule assertion here uses geometry chosen so
 * the expected outcome is obvious by inspection rather than by trusting the
 * generator.
 */
function tinyLevel(overrides: Partial<BrickriseLevel> = {}): BrickriseLevel {
  return {
    seed: "test-seed",
    width: 400,
    height: 400,
    spawn: { x: 100, y: 200 },
    // Far above anything the body reaches, so summit never fires by accident.
    summitY: -10_000,
    platforms: [{ x: 0, y: 200, width: 400, height: 20 }],
    hazards: [],
    checkpoints: [],
    ...overrides,
  };
}

/** A body resting on the tiny level's floor, at x=100. */
function standingSimulation(level: BrickriseLevel): BrickriseSimulation {
  return {
    level,
    run: initialRunState("test-seed"),
    body: placeBodyAt(INITIAL_BODY_STATE, 100, 200),
    input: INITIAL_BRICKRISE_INPUT,
    solids: level.platforms,
  };
}

describe("stepBrickriseSimulation", () => {
  it("accrues elapsed time in fixed steps, never wall-clock", () => {
    const { simulation } = stepBrickriseSimulation(standingSimulation(tinyLevel()));
    expect(simulation.run.elapsedMs).toBe(BRICKRISE_PHYSICS.FIXED_TIMESTEP_MS);
  });

  it("consumes the jump edge exactly once", () => {
    let simulation = applyBrickriseInput(standingSimulation(tinyLevel()), {
      type: "jumpDown",
      source: "keyboard",
    });
    expect(simulation.input.jumpPressed).toBe(true);

    simulation = stepBrickriseSimulation(simulation).simulation;
    expect(simulation.input.jumpPressed).toBe(false);
    // Still held — a held button keeps air control without re-arming the edge.
    expect(simulation.input.jumpHeld).toBe(true);
  });

  it("is inert once the run is completed", () => {
    const base = standingSimulation(tinyLevel());
    const completed: BrickriseSimulation = { ...base, run: { ...base.run, completed: true } };

    const { simulation, events } = stepBrickriseSimulation(completed);

    expect(events).toEqual([]);
    // Elapsed must not keep climbing while a result sits on screen, or the
    // persisted score decays the longer the player looks at it.
    expect(simulation.run.elapsedMs).toBe(0);
    expect(simulation).toBe(completed);
  });

  describe("death", () => {
    const lethal = tinyLevel({ hazards: [{ x: 80, y: 186, width: 40, height: 14, kind: "spike" }] });

    it("records the death and respawns at spawn when no checkpoint is banked", () => {
      const { simulation, events } = stepBrickriseSimulation(standingSimulation(lethal));

      expect(simulation.run.deaths).toBe(1);
      expect(events).toEqual([{ type: "death", deaths: 1, respawnCheckpointIndex: null }]);
      // placeBodyAt centres on x and rests feet on y.
      expect(simulation.body.box.x).toBe(100 - simulation.body.box.width / 2);
      expect(simulation.body.box.y).toBe(200 - simulation.body.box.height);
    });

    it("respawns at the highest checkpoint reached, not at spawn", () => {
      const level = tinyLevel({
        hazards: lethal.hazards,
        checkpoints: [
          { index: 0, x: 250, y: 200 },
          { index: 1, x: 320, y: 200 },
        ],
      });
      const base = standingSimulation(level);
      const banked: BrickriseSimulation = { ...base, run: reachCheckpoint(base.run, 1) };

      const { simulation, events } = stepBrickriseSimulation(banked);

      expect(events).toEqual([{ type: "death", deaths: 1, respawnCheckpointIndex: 1 }]);
      expect(simulation.body.box.x).toBe(320 - simulation.body.box.width / 2);
    });

    it("releases held input so the body does not walk off its respawn", () => {
      const held = applyBrickriseInput(standingSimulation(lethal), {
        type: "moveStart",
        source: "keyboard",
        direction: 1,
      });

      const { simulation } = stepBrickriseSimulation(held);

      expect(simulation.input).toEqual(INITIAL_BRICKRISE_INPUT);
    });

    it("banks no checkpoint on the frame it kills you", () => {
      // Spike and checkpoint occupy the same ledge, both overlapping the body.
      const level = tinyLevel({
        hazards: lethal.hazards,
        checkpoints: [{ index: 0, x: 100, y: 200 }],
      });

      const { simulation, events } = stepBrickriseSimulation(standingSimulation(level));

      expect(simulation.run.checkpointIndex).toBeNull();
      expect(events.map((event) => event.type)).toEqual(["death"]);
    });

    it("does not award the summit on the frame it kills you", () => {
      const level = tinyLevel({ hazards: lethal.hazards, summitY: 200 });

      const { simulation, events } = stepBrickriseSimulation(standingSimulation(level));

      expect(simulation.run.completed).toBe(false);
      expect(events.map((event) => event.type)).toEqual(["death"]);
    });
  });

  describe("checkpoints", () => {
    const level = tinyLevel({ checkpoints: [{ index: 0, x: 100, y: 200 }] });

    it("banks a checkpoint the body stands on", () => {
      const { simulation, events } = stepBrickriseSimulation(standingSimulation(level));

      expect(simulation.run.checkpointIndex).toBe(0);
      expect(events).toEqual([{ type: "checkpoint", index: 0, total: 1 }]);
    });

    it("reports a checkpoint once, not on every frame the body rests on it", () => {
      const first = stepBrickriseSimulation(standingSimulation(level));
      const second = stepBrickriseSimulation(first.simulation);

      expect(second.events).toEqual([]);
      expect(second.simulation.run.checkpointIndex).toBe(0);
    });

    it("never moves progress backwards onto a lower checkpoint", () => {
      const twoCheckpoints = tinyLevel({
        checkpoints: [
          { index: 0, x: 100, y: 200 },
          { index: 1, x: 300, y: 200 },
        ],
      });
      const base = standingSimulation(twoCheckpoints);
      // Standing on checkpoint 0 while 1 is already banked.
      const banked: BrickriseSimulation = { ...base, run: reachCheckpoint(base.run, 1) };

      const { simulation, events } = stepBrickriseSimulation(banked);

      expect(simulation.run.checkpointIndex).toBe(1);
      expect(events).toEqual([]);
    });
  });

  describe("summit", () => {
    it("completes the run when the body's feet reach the summit ledge", () => {
      const level = tinyLevel({ summitY: 200 });

      const { simulation, events } = stepBrickriseSimulation(standingSimulation(level));

      expect(simulation.run.completed).toBe(true);
      expect(events).toEqual([
        { type: "summit", elapsedMs: BRICKRISE_PHYSICS.FIXED_TIMESTEP_MS, deaths: 0 },
      ]);
    });

    it("reports the summit exactly once", () => {
      const level = tinyLevel({ summitY: 200 });
      const first = stepBrickriseSimulation(standingSimulation(level));
      const second = stepBrickriseSimulation(first.simulation);

      expect(second.events).toEqual([]);
    });
  });

  it("is deterministic: identical seeds and inputs produce identical runs", () => {
    const script = (simulation: BrickriseSimulation) => {
      let current = simulation;
      for (let frame = 0; frame < 240; frame += 1) {
        if (frame % 30 === 0) {
          current = applyBrickriseInput(current, { type: "jumpDown", source: "keyboard" });
        }
        if (frame % 30 === 12) {
          current = applyBrickriseInput(current, { type: "jumpUp", source: "keyboard" });
        }
        if (frame === 0) {
          current = applyBrickriseInput(current, { type: "moveStart", source: "keyboard", direction: 1 });
        }
        current = stepBrickriseSimulation(current).simulation;
      }
      return current;
    };

    const build = () => {
      const level = generateBrickriseLevel("determinism-seed");
      return createBrickriseSimulation(initialRunState("determinism-seed"), level, INITIAL_BODY_STATE);
    };

    expect(script(build())).toEqual(script(build()));
  });
});

describe("createBrickriseSimulation", () => {
  it("places a fresh run at spawn", () => {
    const level = generateBrickriseLevel("place-seed");
    const simulation = createBrickriseSimulation(
      initialRunState("place-seed"),
      level,
      INITIAL_BODY_STATE,
    );

    expect(simulation.body.box.y).toBe(level.spawn.y - INITIAL_BODY_STATE.box.height);
    expect(simulation.input).toEqual(INITIAL_BRICKRISE_INPUT);
  });

  it("places a restored run at its banked checkpoint", () => {
    const level = generateBrickriseLevel("restore-seed");
    const checkpoint = level.checkpoints[1];
    const simulation = createBrickriseSimulation(
      reachCheckpoint(initialRunState("restore-seed"), checkpoint.index),
      level,
      INITIAL_BODY_STATE,
    );

    expect(simulation.body.box.y).toBe(checkpoint.y - INITIAL_BODY_STATE.box.height);
  });
});
