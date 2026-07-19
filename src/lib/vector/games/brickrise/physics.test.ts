import { describe, expect, it } from "vitest";
import {
  BRICKRISE_PHYSICS,
  INITIAL_BODY_STATE,
  type Box,
  type BodyState,
  boxesOverlap,
  placeBodyAt,
  stepBody,
} from "@/lib/vector/games/brickrise/physics";

const FLOOR: Box = { x: 0, y: 400, width: 800, height: 20 };
const IDLE = { direction: 0, jumpHeld: false, jumpPressed: false };

function settleOnFloor(solids: readonly Box[] = [FLOOR], dropX = 400): BodyState {
  // Drop from just above the floor until grounded, so tests start from a real
  // physical state rather than an asserted one. dropX must be over the geometry
  // under test — dropping into empty space silently yields an ungrounded body
  // and every downstream assertion becomes meaningless.
  let state = placeBodyAt(INITIAL_BODY_STATE, dropX, 300);
  for (let i = 0; i < 120 && !state.grounded; i += 1) {
    state = stepBody(state, IDLE, solids);
  }
  return state;
}

describe("collision resolution", () => {
  it("lands on a floor instead of passing through it", () => {
    const state = settleOnFloor();
    expect(state.grounded).toBe(true);
    expect(state.box.y + state.box.height).toBeCloseTo(FLOOR.y, 5);
    expect(state.velocity.vy).toBe(0);
  });

  it("caps fall speed so a long drop cannot tunnel through a platform", () => {
    const dropHeight = 4000;
    let state = placeBodyAt(INITIAL_BODY_STATE, 400, FLOOR.y - dropHeight);
    // Enough frames to actually arrive: at MAX_FALL_SPEED the descent needs
    // ~dropHeight/MAX_FALL_SPEED frames, so a short loop would assert nothing
    // except that the body was still in the air.
    const frames = Math.ceil(dropHeight / BRICKRISE_PHYSICS.MAX_FALL_SPEED) + 60;
    for (let i = 0; i < frames; i += 1) {
      state = stepBody(state, IDLE, [FLOOR]);
      expect(state.velocity.vy).toBeLessThanOrEqual(BRICKRISE_PHYSICS.MAX_FALL_SPEED);
    }
    // Having fallen from far above, it must be resting on the floor — not below it.
    expect(state.box.y + state.box.height).toBeCloseTo(FLOOR.y, 5);
  });

  it("stops at a wall without being pushed through it", () => {
    const wall: Box = { x: 500, y: 300, width: 20, height: 120 };
    let state = settleOnFloor([FLOOR, wall]);
    for (let i = 0; i < 200; i += 1) {
      state = stepBody(state, { direction: 1, jumpHeld: false, jumpPressed: false }, [FLOOR, wall]);
    }
    expect(state.box.x + state.box.width).toBeLessThanOrEqual(wall.x + 0.001);
  });

  // Resolving both axes from one overlap makes a body walking a flat floor
  // intermittently register a side collision at tile seams. Two abutting
  // platforms is the exact case that exposes it.
  it("does not catch on the seam between two abutting platforms", () => {
    const left: Box = { x: 0, y: 400, width: 400, height: 20 };
    const right: Box = { x: 400, y: 400, width: 400, height: 20 };
    let state = settleOnFloor([left, right], 300);
    const startX = state.box.x;

    // Bounded so the body cannot reach the far edge at x=800 and fall, which
    // would be a test artefact rather than a seam bug.
    for (let i = 0; i < 90; i += 1) {
      state = stepBody(state, { direction: 1, jumpHeld: false, jumpPressed: false }, [left, right]);
      expect(state.grounded).toBe(true);
    }
    // It crossed the seam at x=400 and kept moving.
    expect(state.box.x).toBeGreaterThan(400);
    expect(state.box.x).toBeGreaterThan(startX + 100);
  });
});

describe("jump feel", () => {
  it("jumps when grounded", () => {
    const grounded = settleOnFloor();
    const jumped = stepBody(grounded, { direction: 0, jumpHeld: true, jumpPressed: true }, [FLOOR]);
    expect(jumped.velocity.vy).toBeLessThan(0);
  });

  it("cannot jump from mid-air once coyote time has elapsed", () => {
    let state = placeBodyAt(INITIAL_BODY_STATE, 400, 100);
    // Burn past the coyote window while falling in open space.
    for (let i = 0; i < BRICKRISE_PHYSICS.COYOTE_FRAMES + 4; i += 1) {
      state = stepBody(state, IDLE, []);
    }
    const before = state.velocity.vy;
    const after = stepBody(state, { direction: 0, jumpHeld: true, jumpPressed: true }, []);
    // Still falling — the press did not produce an impulse.
    expect(after.velocity.vy).toBeGreaterThan(before);
  });

  it("honours coyote time just after walking off a ledge", () => {
    const ledge: Box = { x: 0, y: 400, width: 300, height: 20 };
    let state = settleOnFloor([ledge], 150);
    // Run off the right edge.
    for (let i = 0; i < 200 && state.grounded; i += 1) {
      state = stepBody(state, { direction: 1, jumpHeld: false, jumpPressed: false }, [ledge]);
    }
    expect(state.grounded).toBe(false);
    expect(state.coyoteFrames).toBeGreaterThan(0);

    const jumped = stepBody(state, { direction: 1, jumpHeld: true, jumpPressed: true }, [ledge]);
    expect(jumped.velocity.vy).toBeLessThan(0);
  });

  it("one press cannot yield two jumps via coyote time", () => {
    const grounded = settleOnFloor();
    const first = stepBody(grounded, { direction: 0, jumpHeld: true, jumpPressed: true }, [FLOOR]);
    expect(first.coyoteFrames).toBe(0);

    const second = stepBody(first, { direction: 0, jumpHeld: true, jumpPressed: true }, [FLOOR]);
    // Rising from one impulse only — not re-boosted to the full impulse.
    expect(second.velocity.vy).toBeGreaterThan(BRICKRISE_PHYSICS.JUMP_IMPULSE);
  });

  it("buffers a jump pressed just before landing", () => {
    // Fall from just above the floor so the press lands inside the buffer
    // window — pressing many frames out would correctly expire and prove
    // nothing about buffering.
    let state = placeBodyAt(INITIAL_BODY_STATE, 400, 396);
    state = stepBody(state, { direction: 0, jumpHeld: true, jumpPressed: true }, [FLOOR]);
    expect(state.jumpBufferFrames).toBeGreaterThan(0);

    let rose = false;
    for (let i = 0; i < BRICKRISE_PHYSICS.JUMP_BUFFER_FRAMES + 2; i += 1) {
      state = stepBody(state, { direction: 0, jumpHeld: true, jumpPressed: false }, [FLOOR]);
      if (state.velocity.vy < 0) { rose = true; break; }
    }
    expect(rose).toBe(true);
  });

  it("cuts the rise when jump is released early", () => {
    const grounded = settleOnFloor();
    const held = stepBody(grounded, { direction: 0, jumpHeld: true, jumpPressed: true }, [FLOOR]);
    const released = stepBody(held, { direction: 0, jumpHeld: false, jumpPressed: false }, [FLOOR]);
    const stillHeld = stepBody(held, { direction: 0, jumpHeld: true, jumpPressed: false }, [FLOOR]);
    // Releasing produces less upward velocity than holding.
    expect(released.velocity.vy).toBeGreaterThan(stillHeld.velocity.vy);
  });
});

describe("horizontal movement", () => {
  it("clamps run speed in both directions", () => {
    let state = settleOnFloor();
    for (let i = 0; i < 200; i += 1) {
      state = stepBody(state, { direction: 1, jumpHeld: false, jumpPressed: false }, [FLOOR]);
      expect(Math.abs(state.velocity.vx)).toBeLessThanOrEqual(BRICKRISE_PHYSICS.MAX_RUN_SPEED + 1e-9);
    }
  });

  it("comes to a complete stop rather than drifting forever", () => {
    let state = settleOnFloor();
    for (let i = 0; i < 60; i += 1) {
      state = stepBody(state, { direction: 1, jumpHeld: false, jumpPressed: false }, [FLOOR]);
    }
    for (let i = 0; i < 120; i += 1) {
      state = stepBody(state, IDLE, [FLOOR]);
    }
    expect(state.velocity.vx).toBe(0);
  });

  it("ignores a non-finite or out-of-range direction", () => {
    const grounded = settleOnFloor();
    for (const direction of [Number.NaN, Number.POSITIVE_INFINITY, 99, -99]) {
      expect(() =>
        stepBody(grounded, { direction, jumpHeld: false, jumpPressed: false }, [FLOOR]),
      ).not.toThrow();
    }
    const nan = stepBody(grounded, { direction: Number.NaN, jumpHeld: false, jumpPressed: false }, [FLOOR]);
    expect(Number.isFinite(nan.velocity.vx)).toBe(true);
  });
});

describe("determinism", () => {
  it("produces identical results for identical inputs", () => {
    const run = () => {
      let state = placeBodyAt(INITIAL_BODY_STATE, 400, 200);
      const trace: number[] = [];
      for (let i = 0; i < 300; i += 1) {
        state = stepBody(
          state,
          { direction: i % 3 === 0 ? 1 : -1, jumpHeld: i % 7 < 3, jumpPressed: i % 21 === 0 },
          [FLOOR],
        );
        trace.push(Math.round(state.box.x * 1000), Math.round(state.box.y * 1000));
      }
      return trace;
    };
    expect(run()).toEqual(run());
  });
});

describe("boxesOverlap", () => {
  it("treats touching edges as non-overlapping", () => {
    expect(boxesOverlap({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 10, height: 10 })).toBe(false);
    expect(boxesOverlap({ x: 0, y: 0, width: 10, height: 10 }, { x: 9, y: 0, width: 10, height: 10 })).toBe(true);
  });
});
