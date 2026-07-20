import { describe, expect, it } from "vitest";
import { PAPER_GLIDER_LEVEL_CONFIG } from "@/lib/vector/games/paper-glider/level";
import { STEER_ARRIVE_RADIUS } from "@/lib/vector/games/paper-glider/physics";
import {
  INITIAL_PAPER_GLIDER_INPUT,
  keyboardSteerKeyFor,
  PAPER_GLIDER_INPUT_TUNING,
  type PaperGliderInputAction,
  type PaperGliderInputState,
  reducePaperGliderInput,
  steerTargetFrom,
} from "@/lib/vector/games/paper-glider/inputState";

function reduceAll(actions: readonly PaperGliderInputAction[]): PaperGliderInputState {
  return actions.reduce(reducePaperGliderInput, INITIAL_PAPER_GLIDER_INPUT);
}

const BODY = { x: 2, y: -1 };

describe("reducePaperGliderInput", () => {
  it("stores a pointer steer and claims pointer ownership", () => {
    const state = reduceAll([{ type: "pointerSteer", nx: 0.5, ny: -0.25 }]);
    expect(state.pointerActive).toBe(true);
    expect(state.steerX).toBe(0.5);
    expect(state.steerY).toBe(-0.25);
  });

  it("recenters and releases ownership on pointerRelease", () => {
    const state = reduceAll([
      { type: "pointerSteer", nx: 0.9, ny: 0.9 },
      { type: "pointerRelease" },
    ]);
    expect(state.pointerActive).toBe(false);
    expect(state.steerX).toBe(0);
    expect(state.steerY).toBe(0);
  });

  it("keeps per-key holds independent and releaseAll clears everything", () => {
    const held = reduceAll([
      { type: "keyDown", key: "left" },
      { type: "keyDown", key: "up" },
      { type: "keyUp", key: "left" },
    ]);
    expect(held.keyLeft).toBe(false);
    expect(held.keyUp).toBe(true);

    const cleared = reducePaperGliderInput(held, { type: "releaseAll" });
    expect(cleared).toEqual(INITIAL_PAPER_GLIDER_INPUT);
  });
});

describe("keyboardSteerKeyFor", () => {
  it("maps arrows and WASD to steering keys", () => {
    expect(keyboardSteerKeyFor("ArrowLeft")).toBe("left");
    expect(keyboardSteerKeyFor("KeyA")).toBe("left");
    expect(keyboardSteerKeyFor("ArrowRight")).toBe("right");
    expect(keyboardSteerKeyFor("KeyD")).toBe("right");
    expect(keyboardSteerKeyFor("ArrowUp")).toBe("up");
    expect(keyboardSteerKeyFor("KeyW")).toBe("up");
    expect(keyboardSteerKeyFor("ArrowDown")).toBe("down");
    expect(keyboardSteerKeyFor("KeyS")).toBe("down");
  });

  it("does not claim Tab, Escape, or any non-steering key (WCAG 2.1.2)", () => {
    for (const code of ["Tab", "Escape", "Space", "Enter", "KeyQ", "F5"]) {
      expect(keyboardSteerKeyFor(code), code).toBeNull();
    }
  });
});

describe("steerTargetFrom", () => {
  const C = PAPER_GLIDER_LEVEL_CONFIG;

  it("holds course (target = body) when nothing is steering", () => {
    expect(steerTargetFrom(INITIAL_PAPER_GLIDER_INPUT, BODY)).toEqual({ x: 2, y: -1 });
  });

  it("maps an active pointer linearly onto the room cross-section", () => {
    const state = reduceAll([{ type: "pointerSteer", nx: 1, ny: -0.5 }]);
    expect(steerTargetFrom(state, BODY)).toEqual({
      x: C.ROOM_HALF_WIDTH,
      y: -0.5 * C.ROOM_HALF_HEIGHT,
    });
  });

  it("treats pointer jitter inside the dead zone as exactly centre", () => {
    const state = reduceAll([{ type: "pointerSteer", nx: 0.02, ny: -0.03 }]);
    expect(steerTargetFrom(state, BODY)).toEqual({ x: 0, y: 0 });
  });

  it("lets an active pointer win over held keys", () => {
    const state = reduceAll([
      { type: "keyDown", key: "left" },
      { type: "pointerSteer", nx: 1, ny: 0 },
    ]);
    expect(steerTargetFrom(state, BODY).x).toBe(C.ROOM_HALF_WIDTH);
  });

  it("steers relative to the body under keys, with full authority beyond the arrive radius", () => {
    const state = reduceAll([{ type: "keyDown", key: "right" }]);
    const target = steerTargetFrom(state, BODY);
    expect(target.x - BODY.x).toBe(PAPER_GLIDER_INPUT_TUNING.KEYBOARD_STEER_LEAD);
    expect(target.y).toBe(BODY.y);
    // The lead must exceed the arrive radius or a held key would only ever
    // command partial-authority steering — the relation is derived, not tuned.
    expect(PAPER_GLIDER_INPUT_TUNING.KEYBOARD_STEER_LEAD).toBeGreaterThan(STEER_ARRIVE_RADIUS);
  });

  it("collapses opposing keys to neutral rather than last-wins", () => {
    const state = reduceAll([
      { type: "keyDown", key: "left" },
      { type: "keyDown", key: "right" },
      { type: "keyDown", key: "up" },
      { type: "keyDown", key: "down" },
    ]);
    expect(steerTargetFrom(state, BODY)).toEqual({ x: BODY.x, y: BODY.y });
  });
});
