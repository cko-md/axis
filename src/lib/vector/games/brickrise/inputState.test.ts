import { describe, expect, it } from "vitest";
import {
  INITIAL_BRICKRISE_INPUT,
  type BrickriseInputAction,
  type BrickriseInputState,
  directionFrom,
  keyboardActionFor,
  reduceBrickriseInput,
} from "@/lib/vector/games/brickrise/inputState";

function apply(actions: BrickriseInputAction[], from = INITIAL_BRICKRISE_INPUT): BrickriseInputState {
  return actions.reduce(reduceBrickriseInput, from);
}

describe("movement", () => {
  it("tracks each direction independently", () => {
    const state = apply([
      { type: "moveStart", source: "keyboard", direction: -1 },
      { type: "moveStart", source: "keyboard", direction: 1 },
      { type: "moveEnd", source: "keyboard", direction: -1 },
    ]);
    expect(state.left).toBe(false);
    expect(state.right).toBe(true);
  });

  // Last-wins would fling the body in a direction the player did not choose
  // when both are mashed, which on a hazard ledge reads as the game killing you.
  it("resolves both directions held to neutral", () => {
    const state = apply([
      { type: "moveStart", source: "keyboard", direction: -1 },
      { type: "moveStart", source: "touch", direction: 1 },
    ]);
    expect(directionFrom(state)).toBe(0);
  });

  it("maps single directions", () => {
    expect(directionFrom(apply([{ type: "moveStart", source: "touch", direction: -1 }]))).toBe(-1);
    expect(directionFrom(apply([{ type: "moveStart", source: "touch", direction: 1 }]))).toBe(1);
    expect(directionFrom(INITIAL_BRICKRISE_INPUT)).toBe(0);
  });

  it("treats keyboard and touch as the same source of truth for the physics step", () => {
    // The two sides diverge internally now (each remembers which source is
    // holding it), but that bookkeeping is private to the reducer — the
    // collapsed fields physics.ts and directionFrom actually read must still
    // agree regardless of which source pressed the direction.
    const viaKeyboard = apply([{ type: "moveStart", source: "keyboard", direction: 1 }]);
    const viaTouch = apply([{ type: "moveStart", source: "touch", direction: 1 }]);
    expect(viaKeyboard.right).toBe(viaTouch.right);
    expect(directionFrom(viaKeyboard)).toBe(directionFrom(viaTouch));
  });

  // Regression: a stray on-screen-button release must not cancel a direction
  // still physically held on the keyboard (and vice versa). Before this fix,
  // moveEnd ignored `action.source` entirely and cleared the flat boolean
  // both sources shared.
  it("does not let a touch release cancel a direction held on the keyboard", () => {
    const state = apply([
      { type: "moveStart", source: "keyboard", direction: -1 },
      // A stray pointerup on the on-screen "Move left" button, e.g. a second
      // pointer or an already-released touch replaying its up event.
      { type: "moveEnd", source: "touch", direction: -1 },
    ]);
    expect(state.left).toBe(true);
    expect(directionFrom(state)).toBe(-1);
  });

  it("does not let a keyboard release cancel a direction held on touch", () => {
    const state = apply([
      { type: "moveStart", source: "touch", direction: 1 },
      { type: "moveEnd", source: "keyboard", direction: 1 },
    ]);
    expect(state.right).toBe(true);
    expect(directionFrom(state)).toBe(1);
  });

  it("clears a direction once every source holding it releases", () => {
    let state = apply([
      { type: "moveStart", source: "keyboard", direction: 1 },
      { type: "moveStart", source: "touch", direction: 1 },
    ]);
    expect(state.right).toBe(true);

    state = reduceBrickriseInput(state, { type: "moveEnd", source: "keyboard", direction: 1 });
    expect(state.right).toBe(true);

    state = reduceBrickriseInput(state, { type: "moveEnd", source: "touch", direction: 1 });
    expect(state.right).toBe(false);
  });
});

describe("jump edge", () => {
  it("raises the edge on press and clears it after one frame", () => {
    let state = apply([{ type: "jumpDown", source: "keyboard" }]);
    expect(state.jumpPressed).toBe(true);
    expect(state.jumpHeld).toBe(true);

    state = reduceBrickriseInput(state, { type: "frame" });
    expect(state.jumpPressed).toBe(false);
    expect(state.jumpHeld).toBe(true);
  });

  // Keyboard auto-repeat fires jumpDown continuously while held. Re-arming the
  // edge would let one held key jump again every time the buffer expired.
  it("does not re-arm the edge while already held", () => {
    let state = apply([{ type: "jumpDown", source: "keyboard" }]);
    state = reduceBrickriseInput(state, { type: "frame" });
    state = reduceBrickriseInput(state, { type: "jumpDown", source: "keyboard" });
    expect(state.jumpPressed).toBe(false);
  });

  it("re-arms only after a release", () => {
    let state = apply([{ type: "jumpDown", source: "keyboard" }]);
    state = reduceBrickriseInput(state, { type: "frame" });
    state = reduceBrickriseInput(state, { type: "jumpUp", source: "keyboard" });
    state = reduceBrickriseInput(state, { type: "jumpDown", source: "keyboard" });
    expect(state.jumpPressed).toBe(true);
  });

  // Regression: game.ts's activePointerId guard only deduplicates pointers on
  // the SAME touch button — it does nothing to stop a touch release from
  // clearing a keyboard-set flag. A stray click on the on-screen jump button
  // must not cut a jump held by Space, which would trigger the jump-cut
  // physics mid-hold.
  it("does not let a touch release cancel a jump held on the keyboard", () => {
    const state = apply([
      { type: "jumpDown", source: "keyboard" },
      { type: "jumpUp", source: "touch" },
    ]);
    expect(state.jumpHeld).toBe(true);
  });

  it("does not let a keyboard release cancel a jump held on touch", () => {
    const state = apply([
      { type: "jumpDown", source: "touch" },
      { type: "jumpUp", source: "keyboard" },
    ]);
    expect(state.jumpHeld).toBe(true);
  });

  it("clears the jump once every source holding it releases", () => {
    let state = apply([
      { type: "jumpDown", source: "keyboard" },
      { type: "jumpDown", source: "touch" },
    ]);
    expect(state.jumpHeld).toBe(true);

    state = reduceBrickriseInput(state, { type: "jumpUp", source: "keyboard" });
    expect(state.jumpHeld).toBe(true);

    state = reduceBrickriseInput(state, { type: "jumpUp", source: "touch" });
    expect(state.jumpHeld).toBe(false);
  });

  // The second source pressing while the first still holds must not re-arm
  // the edge either — that is the same held-input-cannot-jump-every-frame
  // rule as auto-repeat, just arriving from the other source.
  it("does not re-arm the edge when a second source presses while already held", () => {
    let state = apply([{ type: "jumpDown", source: "keyboard" }]);
    state = reduceBrickriseInput(state, { type: "frame" });
    state = reduceBrickriseInput(state, { type: "jumpDown", source: "touch" });
    expect(state.jumpPressed).toBe(false);
    expect(state.jumpHeld).toBe(true);
  });
});

describe("releaseAll", () => {
  // Losing focus mid-run with a direction held would otherwise leave the body
  // running into a hazard while the tab is not even visible.
  it("clears every held input", () => {
    const state = apply([
      { type: "moveStart", source: "keyboard", direction: 1 },
      { type: "jumpDown", source: "keyboard" },
      { type: "releaseAll" },
    ]);
    expect(state).toEqual(INITIAL_BRICKRISE_INPUT);
  });
});

describe("keyboardActionFor", () => {
  it("maps both arrow and WASD bindings named in the manifest", () => {
    for (const code of ["ArrowLeft", "KeyA"]) {
      expect(keyboardActionFor(code, "down")).toMatchObject({ type: "moveStart", direction: -1 });
    }
    for (const code of ["ArrowRight", "KeyD"]) {
      expect(keyboardActionFor(code, "down")).toMatchObject({ type: "moveStart", direction: 1 });
    }
    for (const code of ["Space", "ArrowUp", "KeyW"]) {
      expect(keyboardActionFor(code, "down")).toMatchObject({ type: "jumpDown" });
    }
  });

  it("maps releases to the matching end action", () => {
    expect(keyboardActionFor("ArrowLeft", "up")).toMatchObject({ type: "moveEnd", direction: -1 });
    expect(keyboardActionFor("Space", "up")).toMatchObject({ type: "jumpUp" });
  });

  it("ignores keys the game does not use, so browser shortcuts still work", () => {
    for (const code of ["KeyF", "Tab", "Escape", "F5", "MetaLeft", ""]) {
      expect(keyboardActionFor(code, "down")).toBeNull();
    }
  });
});

describe("purity", () => {
  it("never mutates the state it is given", () => {
    const frozen = Object.freeze({ ...INITIAL_BRICKRISE_INPUT });
    expect(() =>
      reduceBrickriseInput(frozen, { type: "jumpDown", source: "keyboard" }),
    ).not.toThrow();
    expect(frozen.jumpHeld).toBe(false);
  });
});
