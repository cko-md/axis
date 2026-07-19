import { describe, expect, it } from "vitest";
import {
  distanceToSpeedCap,
  INITIAL_GLIDER_STATE,
  maxSteerableRadius,
  PAPER_GLIDER_PHYSICS,
  speedAtDistance,
  steerVelocityToward,
  stepGlider,
} from "@/lib/vector/games/paper-glider/physics";
import { PAPER_GLIDER_LEVEL_CONFIG } from "@/lib/vector/games/paper-glider/level";

describe("speedAtDistance", () => {
  it("starts at SPEED_BASE", () => {
    expect(speedAtDistance(0)).toBe(PAPER_GLIDER_PHYSICS.SPEED_BASE);
  });

  it("is monotonically non-decreasing with distance", () => {
    let previous = speedAtDistance(0);
    for (let z = 0; z <= 2000; z += 25) {
      const speed = speedAtDistance(z);
      expect(speed).toBeGreaterThanOrEqual(previous);
      previous = speed;
    }
  });

  it("never exceeds SPEED_CAP, however far the distance", () => {
    expect(speedAtDistance(1_000_000)).toBe(PAPER_GLIDER_PHYSICS.SPEED_CAP);
  });

  it("treats negative or non-finite distance defensively as zero", () => {
    expect(speedAtDistance(-50)).toBe(PAPER_GLIDER_PHYSICS.SPEED_BASE);
    expect(speedAtDistance(Number.NaN)).toBe(PAPER_GLIDER_PHYSICS.SPEED_BASE);
  });
});

describe("distanceToSpeedCap", () => {
  it("matches the closed-form relation between SPEED_BASE, SPEED_CAP, and SPEED_GROWTH_PER_UNIT", () => {
    const P = PAPER_GLIDER_PHYSICS;
    const distance = distanceToSpeedCap();
    // Reconstructing the check independently of the function under test, not
    // just re-deriving the same expression it uses internally.
    expect(P.SPEED_BASE + P.SPEED_GROWTH_PER_UNIT * distance).toBeCloseTo(P.SPEED_CAP, 6);
    expect(speedAtDistance(distance - 1)).toBeLessThan(P.SPEED_CAP);
    expect(speedAtDistance(distance + 1)).toBe(P.SPEED_CAP);
  });

  it("is reached well inside the 30-room oracle window, not past it", () => {
    // If this were false, the passability oracle's MIN_ROOMS corpus would
    // never actually exercise capped-speed generation, and the 15.8 lesson
    // ("prove the real step function agrees with the generator") would go
    // unchecked for exactly the harder half of the flight.
    const MIN_ROOMS = 30;
    const distanceCoveredByMinRooms = MIN_ROOMS * PAPER_GLIDER_LEVEL_CONFIG.ROOM_DEPTH;
    expect(distanceCoveredByMinRooms).toBeGreaterThan(distanceToSpeedCap());
  });
});

describe("steerVelocityToward", () => {
  it("snaps directly to the desired velocity when the gap is within maxDelta", () => {
    const result = steerVelocityToward(0, 0, 0.1, 0.1, 0.5);
    expect(result).toEqual({ vx: 0.1, vy: 0.1 });
  });

  it("moves the vector by exactly maxDelta in magnitude when the gap is larger", () => {
    const result = steerVelocityToward(0, 0, 10, 0, 0.05);
    expect(Math.hypot(result.vx, result.vy)).toBeCloseTo(0.05, 10);
    expect(result.vx).toBeCloseTo(0.05, 10);
    expect(result.vy).toBeCloseTo(0, 10);
  });

  it("clamps a diagonal gap by the combined vector magnitude, not per axis", () => {
    const result = steerVelocityToward(0, 0, 10, 10, 0.1);
    expect(Math.hypot(result.vx, result.vy)).toBeCloseTo(0.1, 10);
    // Equal gap on both axes, so the step splits evenly rather than granting
    // up to 0.1 on EACH axis (which would let diagonal turning out-accelerate
    // axis-aligned turning).
    expect(result.vx).toBeCloseTo(result.vy, 10);
  });
});

describe("stepGlider", () => {
  const FAR_TARGET = { x: 1000, y: 0 };

  it("always advances z forward, since forward speed is always positive", () => {
    let state = INITIAL_GLIDER_STATE;
    for (let i = 0; i < 50; i += 1) {
      const next = stepGlider(state, { x: 0, y: 0 });
      expect(next.z).toBeGreaterThan(state.z);
      state = next;
    }
  });

  it("never exceeds STEER_MAX_SPEED in combined lateral/vertical velocity", () => {
    let state = INITIAL_GLIDER_STATE;
    for (let i = 0; i < 200; i += 1) {
      state = stepGlider(state, FAR_TARGET);
      expect(Math.hypot(state.vx, state.vy)).toBeLessThanOrEqual(PAPER_GLIDER_PHYSICS.STEER_MAX_SPEED + 1e-9);
    }
  });

  it("converges toward a fixed reachable target rather than orbiting or overshooting", () => {
    let state = INITIAL_GLIDER_STATE;
    const target = { x: 2, y: -1.5 };
    for (let i = 0; i < 400; i += 1) {
      state = stepGlider(state, target);
    }
    expect(state.x).toBeCloseTo(target.x, 1);
    expect(state.y).toBeCloseTo(target.y, 1);
  });

  it("holds still laterally when already at the target", () => {
    const atTarget = { x: 3, y: 3, z: 0, vx: 0, vy: 0 };
    const next = stepGlider(atTarget, { x: 3, y: 3 });
    expect(next.x).toBe(3);
    expect(next.y).toBe(3);
    expect(next.vx).toBe(0);
    expect(next.vy).toBe(0);
  });

  it("is deterministic: the same target sequence always produces the same trace", () => {
    const run = () => {
      let state = INITIAL_GLIDER_STATE;
      const trace: number[] = [];
      for (let i = 0; i < 300; i += 1) {
        const target = { x: Math.sin(i / 17) * 4, y: Math.cos(i / 23) * 3 };
        state = stepGlider(state, target);
        trace.push(Math.round(state.x * 1e6), Math.round(state.y * 1e6), Math.round(state.z * 1e6));
      }
      return trace;
    };
    expect(run()).toEqual(run());
  });
});

describe("maxSteerableRadius", () => {
  it("is zero for zero or negative depth", () => {
    expect(maxSteerableRadius(0, 0)).toBe(0);
    expect(maxSteerableRadius(0, -10)).toBe(0);
  });

  it("is positive for any positive depth", () => {
    expect(maxSteerableRadius(0, 10)).toBeGreaterThan(0);
  });

  it("grows monotonically with depth at a fixed starting distance — more time cannot reduce what is reachable", () => {
    const startZ = 0;
    let previous = 0;
    for (const depth of [5, 10, 20, 40, 80, 160]) {
      const radius = maxSteerableRadius(startZ, depth);
      expect(radius).toBeGreaterThanOrEqual(previous);
      previous = radius;
    }
  });

  it("shrinks for the same depth once the speed curve has ramped up — this is the cap/bound relationship the generator relies on", () => {
    const depth = PAPER_GLIDER_LEVEL_CONFIG.ROOM_DEPTH;
    const early = maxSteerableRadius(0, depth);
    const atCap = maxSteerableRadius(distanceToSpeedCap(), depth);
    expect(atCap).toBeLessThan(early);
  });

  it("independently reproduces the reachable radius by driving the real step function, not a closed-form guess", () => {
    // Manual re-simulation using stepGlider directly, mirroring what
    // maxSteerableRadius does internally, so this test would catch a bug in
    // the function's own bookkeeping (e.g. an off-by-one on the loop guard)
    // rather than just re-asserting its own output.
    const depth = 40;
    let state = INITIAL_GLIDER_STATE;
    const target = { x: 1_000_000, y: 0 };
    while (state.z < depth) {
      state = stepGlider(state, target);
    }
    expect(maxSteerableRadius(0, depth)).toBeCloseTo(state.x, 6);
  });

  it("still leaves a non-trivial passability bound once capped, wide enough for a real doorway to sit off-centre", () => {
    const C = PAPER_GLIDER_LEVEL_CONFIG;
    const radiusAtCap = maxSteerableRadius(distanceToSpeedCap(), C.ROOM_DEPTH);
    const usableBound = radiusAtCap * C.OPENING_DRIFT_SAFETY_MARGIN;
    // If this collapsed toward zero, every capped-speed room would degenerate
    // into a dead-straight tunnel — a design failure this test exists to
    // catch even though it would not be a passability failure.
    expect(usableBound).toBeGreaterThan(C.OPENING_HALF_WIDTH);
  });
});

describe("per-step displacement bounds used elsewhere in the game", () => {
  it("keeps the worst-case single-step 3D displacement smaller than the ring capture diameter, so a fast pass cannot tunnel through a ring", () => {
    const P = PAPER_GLIDER_PHYSICS;
    const worstCaseStepDisplacement = Math.hypot(P.STEER_MAX_SPEED, P.SPEED_CAP);
    const C = PAPER_GLIDER_LEVEL_CONFIG;
    const captureDiameter = (C.RING_TRIGGER_RADIUS + P.HULL_RADIUS) * 2;
    expect(worstCaseStepDisplacement).toBeLessThan(captureDiameter);
  });

  it("keeps STEER_MAX_SPEED under the furniture footprint width, so a fast lateral pass cannot tunnel through furniture sideways", () => {
    const P = PAPER_GLIDER_PHYSICS;
    const fullFurnitureWidth = PAPER_GLIDER_LEVEL_CONFIG.FURNITURE_HALF_SIZE_XY * 2;
    expect(P.STEER_MAX_SPEED).toBeLessThan(fullFurnitureWidth);
  });
});
