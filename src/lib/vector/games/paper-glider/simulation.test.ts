import { describe, expect, it } from "vitest";
import {
  createPaperGliderSimulation,
  PAPER_GLIDER_RUNTIME,
  type PaperGliderSimulation,
  stepPaperGliderSimulation,
} from "@/lib/vector/games/paper-glider/simulation";
import { PAPER_GLIDER_LEVEL_CONFIG, type PaperGliderRoom, roomAtDistance } from "@/lib/vector/games/paper-glider/level";
import { INITIAL_GLIDER_STATE } from "@/lib/vector/games/paper-glider/physics";
import { initialRunState } from "@/lib/vector/games/paper-glider/progress";

/**
 * Hand-crafted single-room levels for deterministic collision scenarios.
 * Generated levels are exercised exhaustively by the passability oracle
 * (see the dedicated oracle spec); these engineer specific failure paths
 * directly rather than hoping a random seed happens to produce one.
 */
function simulationWithRoom(room: PaperGliderRoom): PaperGliderSimulation {
  return {
    level: { seed: "engineered", rooms: [room] },
    body: INITIAL_GLIDER_STATE,
    run: initialRunState("engineered"),
  };
}

const OPENING = { halfWidth: PAPER_GLIDER_LEVEL_CONFIG.OPENING_HALF_WIDTH, halfHeight: PAPER_GLIDER_LEVEL_CONFIG.OPENING_HALF_HEIGHT };
const CENTRED_ROOM: PaperGliderRoom = {
  index: 1,
  entry: { index: 0, x: 0, y: 0, ...OPENING, z: 0 },
  exit: { index: 1, x: 0, y: 0, ...OPENING, z: PAPER_GLIDER_LEVEL_CONFIG.ROOM_DEPTH },
  furniture: [],
  rings: [],
};

describe("createPaperGliderSimulation", () => {
  it("starts at the initial glider state with an alive, empty run", () => {
    const sim = createPaperGliderSimulation("seed-1");
    expect(sim.body).toEqual(INITIAL_GLIDER_STATE);
    expect(sim.run.alive).toBe(true);
    expect(sim.run.distance).toBe(0);
    expect(sim.run.seed).toBe("seed-1");
  });

  it("generates INITIAL_ROOM_COUNT rooms up front", () => {
    const sim = createPaperGliderSimulation("seed-1");
    expect(sim.level.rooms).toHaveLength(PAPER_GLIDER_RUNTIME.INITIAL_ROOM_COUNT);
  });
});

describe("stepPaperGliderSimulation — normal flight", () => {
  it("advances distance every step while flying straight down the centreline", () => {
    let sim = simulationWithRoom(CENTRED_ROOM);
    let previousDistance = sim.run.distance;
    for (let i = 0; i < 50; i += 1) {
      const result = stepPaperGliderSimulation(sim, { x: 0, y: 0 });
      sim = result.simulation;
      expect(sim.run.distance).toBeGreaterThan(previousDistance);
      previousDistance = sim.run.distance;
    }
    expect(sim.run.alive).toBe(true);
  });

  it("emits roomCleared and stays alive when the doorway is threaded", () => {
    // Stop as soon as the one hand-crafted room is cleared — the level
    // auto-extends past it with generated rooms whose doorway is not
    // necessarily at (0, 0), so continuing to target (0, 0) blindly would
    // test the generator's rooms, not this room's collision path.
    let sim = simulationWithRoom(CENTRED_ROOM);
    let clearedEvents = 0;
    for (let i = 0; i < 200 && sim.run.alive && clearedEvents === 0; i += 1) {
      const result = stepPaperGliderSimulation(sim, { x: 0, y: 0 });
      sim = result.simulation;
      clearedEvents += result.events.filter((e) => e.type === "roomCleared").length;
    }
    expect(sim.run.alive).toBe(true);
    expect(clearedEvents).toBe(1);
  });
});

describe("stepPaperGliderSimulation — wall collision", () => {
  it("ends the run when the doorway plane is crossed off-centre", () => {
    let sim = simulationWithRoom(CENTRED_ROOM);
    let sawCollision = false;
    for (let i = 0; i < 200 && sim.run.alive; i += 1) {
      // A steady lateral target well outside the opening's half-width but
      // still safely inside the room's own walls, so this isolates a missed
      // doorway from a side-wall departure.
      const result = stepPaperGliderSimulation(sim, { x: 8, y: 0 });
      sim = result.simulation;
      const collision = result.events.find((e) => e.type === "collision");
      if (collision && collision.type === "collision") {
        expect(collision.reason).toBe("wall");
        sawCollision = true;
      }
    }
    expect(sawCollision).toBe(true);
    expect(sim.run.alive).toBe(false);
    expect(sim.run.collisionReason).toBe("wall");
  });
});

describe("stepPaperGliderSimulation — furniture collision", () => {
  const roomWithFurniture: PaperGliderRoom = {
    ...CENTRED_ROOM,
    furniture: [{ x: 0, y: 0, z: 20, halfX: 0.6, halfY: 0.6, halfZ: 1.6 }],
  };

  it("ends the run on overlap and reports the furniture reason", () => {
    let sim = simulationWithRoom(roomWithFurniture);
    let sawCollision = false;
    for (let i = 0; i < 200 && sim.run.alive; i += 1) {
      const result = stepPaperGliderSimulation(sim, { x: 0, y: 0 });
      sim = result.simulation;
      const collision = result.events.find((e) => e.type === "collision");
      if (collision && collision.type === "collision") {
        expect(collision.reason).toBe("furniture");
        sawCollision = true;
      }
    }
    expect(sawCollision).toBe(true);
    expect(sim.run.collisionReason).toBe("furniture");
  });

  it("is inert after collision — further steps change nothing", () => {
    let sim = simulationWithRoom(roomWithFurniture);
    for (let i = 0; i < 200 && sim.run.alive; i += 1) {
      sim = stepPaperGliderSimulation(sim, { x: 0, y: 0 }).simulation;
    }
    expect(sim.run.alive).toBe(false);
    const frozen = sim;
    const result = stepPaperGliderSimulation(sim, { x: 5, y: 5 });
    expect(result.events).toEqual([]);
    expect(result.simulation).toBe(frozen);
  });
});

describe("stepPaperGliderSimulation — bounds collision", () => {
  it("ends the run when the glider leaves the room's own walls chasing an unreachable target", () => {
    let sim = simulationWithRoom(CENTRED_ROOM);
    let sawCollision = false;
    for (let i = 0; i < 200 && sim.run.alive; i += 1) {
      const result = stepPaperGliderSimulation(sim, { x: 1000, y: 0 });
      sim = result.simulation;
      const collision = result.events.find((e) => e.type === "collision");
      if (collision && collision.type === "collision") {
        expect(collision.reason).toBe("bounds");
        sawCollision = true;
      }
    }
    expect(sawCollision).toBe(true);
    expect(sim.run.collisionReason).toBe("bounds");
  });
});

describe("stepPaperGliderSimulation — ring collection", () => {
  const roomWithRing: PaperGliderRoom = {
    ...CENTRED_ROOM,
    rings: [{ index: 0, x: 0, y: 0, z: 20 }],
  };

  it("fires a ring event and increases score when flown through", () => {
    let sim = simulationWithRoom(roomWithRing);
    let ringEvents = 0;
    let scoreBefore = 0;
    for (let i = 0; i < 200 && sim.run.alive; i += 1) {
      const before = sim.run.ringsCollected;
      const result = stepPaperGliderSimulation(sim, { x: 0, y: 0 });
      sim = result.simulation;
      if (result.events.some((e) => e.type === "ring")) {
        ringEvents += 1;
        expect(sim.run.ringsCollected).toBe(before + 1);
      }
      scoreBefore = Math.max(scoreBefore, sim.run.ringsCollected);
    }
    expect(ringEvents).toBe(1);
    expect(sim.run.ringsCollected).toBe(1);
    expect(scoreBefore).toBe(1);
  });

  it("does not re-collect the same ring on a second pass through its trigger volume", () => {
    // Fly past the ring, then keep the target pinned exactly on it so the
    // hull lingers in the trigger volume for many additional steps.
    let sim = simulationWithRoom(roomWithRing);
    for (let i = 0; i < 200 && sim.run.alive; i += 1) {
      sim = stepPaperGliderSimulation(sim, { x: 0, y: 0 }).simulation;
    }
    expect(sim.run.ringsCollected).toBe(1);
  });
});

describe("stepPaperGliderSimulation — is a no-op once the run has already ended", () => {
  it("returns the same simulation reference and no events", () => {
    let sim = simulationWithRoom(CENTRED_ROOM);
    for (let i = 0; i < 200 && sim.run.alive; i += 1) {
      sim = stepPaperGliderSimulation(sim, { x: 1000, y: 0 }).simulation;
    }
    expect(sim.run.alive).toBe(false);
    const result = stepPaperGliderSimulation(sim, { x: 0, y: 0 });
    expect(result.simulation).toBe(sim);
    expect(result.events).toEqual([]);
  });
});

describe("auto-extension keeps the level ahead of the glider", () => {
  it("never runs out of generated rooms across a long flight, and the level genuinely grows", () => {
    let sim = createPaperGliderSimulation("extend-check");
    const initialRoomCount = sim.level.rooms.length;
    for (let i = 0; i < 3000 && sim.run.alive; i += 1) {
      const room = roomAtDistance(sim.level, sim.body.z);
      const target = { x: room.exit.x, y: room.exit.y };
      sim = stepPaperGliderSimulation(sim, target).simulation;
    }
    expect(sim.level.rooms.length).toBeGreaterThan(initialRoomCount);
    expect(sim.body.z).toBeGreaterThan(0);
  });
});

describe("determinism", () => {
  it("produces an identical simulation trace for the same seed and target policy", () => {
    const run = () => {
      let sim = createPaperGliderSimulation("determinism-check");
      const trace: number[] = [];
      for (let i = 0; i < 400 && sim.run.alive; i += 1) {
        const room = roomAtDistance(sim.level, sim.body.z);
        // A deterministic but non-trivial policy: chase the exit with a
        // wobble, so the trace actually exercises steering, not just z.
        const target = { x: room.exit.x + Math.sin(i / 9) * 1.5, y: room.exit.y + Math.cos(i / 13) * 1 };
        sim = stepPaperGliderSimulation(sim, target).simulation;
        trace.push(
          Math.round(sim.body.x * 1e6),
          Math.round(sim.body.y * 1e6),
          Math.round(sim.body.z * 1e6),
          sim.run.ringsCollected,
          sim.run.alive ? 1 : 0,
        );
      }
      return trace;
    };
    expect(run()).toEqual(run());
  });
});
