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
import {
  BRICKRISE_LEVEL_CONFIG,
  generateBrickriseLevel,
  solidBoxesFor,
} from "@/lib/vector/games/brickrise/level";

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

describe("reachability", () => {
  /**
   * The invariant nothing checked before Wave 15.8: a jump has to actually
   * clear a floor.
   *
   * The tuning constants here and the floor spacing in level.ts were tuned
   * independently, and at JUMP_IMPULSE -11.6 the peak rise was 102.78 px
   * against a 132 px gap — every generated tower was unclimbable, checkpoint 0
   * was unreachable, and the summit could never fire. Every other test passed,
   * because they asserted the gaps were *equal*, never that one was *jumpable*.
   *
   * This derives the rise by running the real stepBody, so the two constants
   * cannot drift apart again without failing here.
   */
  function peakRise(): number {
    const floor: Box = { x: -1000, y: 0, width: 4000, height: 20 };
    // Feet resting on the floor.
    let body = placeBodyAt(INITIAL_BODY_STATE, 0, 0);
    // One grounded step so `grounded` is true and the jump is legal.
    body = stepBody(body, { direction: 0, jumpHeld: false, jumpPressed: false }, [floor]);
    const startFeet = body.box.y + body.box.height;

    let highestFeet = startFeet;
    body = stepBody(body, { direction: 0, jumpHeld: true, jumpPressed: true }, [floor]);
    for (let frame = 0; frame < 240; frame += 1) {
      // Hold jump: variable jump height means releasing early cuts the rise, so
      // the ceiling of what a player can do is measured with the button held.
      body = stepBody(body, { direction: 0, jumpHeld: true, jumpPressed: false }, [floor]);
      highestFeet = Math.min(highestFeet, body.box.y + body.box.height);
      if (body.grounded) break;
    }
    return startFeet - highestFeet;
  }

  it("clears a full floor gap with margin to spare", () => {
    const rise = peakRise();

    expect(
      rise,
      `a jump rises ${rise.toFixed(2)}px but a floor is ${BRICKRISE_LEVEL_CONFIG.FLOOR_SPACING}px up — the tower is unclimbable`,
    ).toBeGreaterThan(BRICKRISE_LEVEL_CONFIG.FLOOR_SPACING);

    // Margin, not a bare pass: landing needs slack for the platform's own
    // thickness and for a player who is not frame-perfect.
    expect(rise - BRICKRISE_LEVEL_CONFIG.FLOOR_SPACING).toBeGreaterThan(12);
  });

  it("does not let a single jump skip a whole floor", () => {
    // A jump that clears two floors would collapse the climb the generator's
    // zig-zag exists to create.
    expect(peakRise()).toBeLessThan(BRICKRISE_LEVEL_CONFIG.FLOOR_SPACING * 2);
  });

  /**
   * Can a player standing on `fromY` reach `target` at all?
   *
   * Searches start positions and held directions rather than assuming one
   * line of play. A straight-up jump from directly beneath a ledge is NOT the
   * test: the body's head strikes the platform underside and resolveAxis
   * pushes it back down, which is correct platformer behaviour. Real ascent is
   * jump-from-beside then drift across.
   */
  function canReach(
    solids: readonly Box[],
    fromY: number,
    target: Readonly<{ x: number; y: number; width: number }>,
  ): boolean {
    for (let startX = target.x - 200; startX <= target.x + target.width + 200; startX += 8) {
      for (const direction of [-1, 0, 1]) {
        let body = placeBodyAt(INITIAL_BODY_STATE, startX, fromY);
        body = stepBody(body, { direction: 0, jumpHeld: false, jumpPressed: false }, solids);
        if (!body.grounded) continue;
        body = stepBody(body, { direction, jumpHeld: true, jumpPressed: true }, solids);

        for (let frame = 0; frame < 180; frame += 1) {
          body = stepBody(body, { direction, jumpHeld: true, jumpPressed: false }, solids);
          if (body.grounded && Math.abs(body.box.y + body.box.height - target.y) < 0.001) return true;
          if (body.grounded) break;
        }
      }
    }
    return false;
  }

  it("makes every floor of a generated tower reachable from the one below", () => {
    // End-to-end against real generated geometry. This is the assertion whose
    // absence let an unclimbable tower ship: it fails outright if the jump and
    // the floor spacing ever stop agreeing.
    for (const seed of ["reachability-a", "reachability-b", "reachability-c"]) {
      const level = generateBrickriseLevel(seed);
      const solids = solidBoxesFor(level);
      const climbable = level.platforms
        .filter((p) => p.x >= 0 && p.x < BRICKRISE_LEVEL_CONFIG.TOWER_WIDTH)
        .sort((a, b) => b.y - a.y);

      for (let i = 1; i < climbable.length; i += 1) {
        expect(
          canReach(solids, climbable[i - 1].y, climbable[i]),
          `${seed}: floor at y=${climbable[i].y} is unreachable from y=${climbable[i - 1].y}`,
        ).toBe(true);
      }
    }
  });
});
