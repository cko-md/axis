/**
 * Brickrise input — one normalized state machine for keyboard and touch.
 *
 * The binding spec requires both, and the failure mode when they are handled
 * separately is that they drift: touch gains a jump behaviour keyboard lacks,
 * or a held key and a held thumb produce different air control. Both sources
 * reduce into the same state here, so the physics step cannot tell them apart
 * and there is only one set of rules to test.
 *
 * `jumpPressed` is an EDGE, true only on the frame the press begins. The
 * physics step consumes it to seed the jump buffer; a level held button must
 * not re-trigger a jump every frame.
 */

export type BrickriseInputSource = "keyboard" | "touch";

export type BrickriseInputAction =
  | { type: "moveStart"; source: BrickriseInputSource; direction: -1 | 1 }
  | { type: "moveEnd"; source: BrickriseInputSource; direction: -1 | 1 }
  | { type: "jumpDown"; source: BrickriseInputSource }
  | { type: "jumpUp"; source: BrickriseInputSource }
  /** Advance one frame: clears edges. Must be dispatched exactly once per step. */
  | { type: "frame" }
  /** Focus/visibility loss. Releases everything so the body cannot run away. */
  | { type: "releaseAll" };

export type BrickriseInputState = Readonly<{
  left: boolean;
  right: boolean;
  jumpHeld: boolean;
  jumpPressed: boolean;
  /**
   * Held state tracked per source. The physics step only ever reads the
   * collapsed `left`/`right`/`jumpHeld` above — these four exist so a release
   * from one source cannot cancel a hold still active on the other. Without
   * them, a keyboard-held direction or jump is cancelled by an unrelated
   * pointerup on the matching on-screen button, because the two sources
   * shared one flat boolean.
   */
  leftKeyboard: boolean;
  leftTouch: boolean;
  rightKeyboard: boolean;
  rightTouch: boolean;
  jumpKeyboard: boolean;
  jumpTouch: boolean;
}>;

export const INITIAL_BRICKRISE_INPUT: BrickriseInputState = Object.freeze({
  left: false,
  right: false,
  jumpHeld: false,
  jumpPressed: false,
  leftKeyboard: false,
  leftTouch: false,
  rightKeyboard: false,
  rightTouch: false,
  jumpKeyboard: false,
  jumpTouch: false,
});

/**
 * Apply a press/release from one source to a per-source held pair, and
 * collapse the result with OR. The other source's flag is left untouched, so
 * a release only ever clears the half of the hold that source owns.
 */
function withHeld(
  heldKeyboard: boolean,
  heldTouch: boolean,
  source: BrickriseInputSource,
  pressed: boolean,
): { held: boolean; heldKeyboard: boolean; heldTouch: boolean } {
  const keyboard = source === "keyboard" ? pressed : heldKeyboard;
  const touch = source === "touch" ? pressed : heldTouch;
  return { held: keyboard || touch, heldKeyboard: keyboard, heldTouch: touch };
}

export function reduceBrickriseInput(
  state: BrickriseInputState,
  action: BrickriseInputAction,
): BrickriseInputState {
  switch (action.type) {
    case "moveStart": {
      if (action.direction === -1) {
        const { held, heldKeyboard, heldTouch } = withHeld(state.leftKeyboard, state.leftTouch, action.source, true);
        return { ...state, left: held, leftKeyboard: heldKeyboard, leftTouch: heldTouch };
      }
      const { held, heldKeyboard, heldTouch } = withHeld(state.rightKeyboard, state.rightTouch, action.source, true);
      return { ...state, right: held, rightKeyboard: heldKeyboard, rightTouch: heldTouch };
    }

    case "moveEnd": {
      if (action.direction === -1) {
        const { held, heldKeyboard, heldTouch } = withHeld(state.leftKeyboard, state.leftTouch, action.source, false);
        return { ...state, left: held, leftKeyboard: heldKeyboard, leftTouch: heldTouch };
      }
      const { held, heldKeyboard, heldTouch } = withHeld(state.rightKeyboard, state.rightTouch, action.source, false);
      return { ...state, right: held, rightKeyboard: heldKeyboard, rightTouch: heldTouch };
    }

    case "jumpDown": {
      const { held, heldKeyboard, heldTouch } = withHeld(state.jumpKeyboard, state.jumpTouch, action.source, true);
      // Re-pressing while already held (keyboard auto-repeat, a second
      // finger, or the other source already holding it) must not re-arm the
      // edge — that would let a held input produce a jump on every frame the
      // buffer expired. The per-source flags still update underneath so a
      // later release from the other source does not wrongly clear a hold
      // this source is also contributing to.
      if (state.jumpHeld) {
        return { ...state, jumpHeld: held, jumpKeyboard: heldKeyboard, jumpTouch: heldTouch };
      }
      return { ...state, jumpHeld: held, jumpPressed: true, jumpKeyboard: heldKeyboard, jumpTouch: heldTouch };
    }

    case "jumpUp": {
      const { held, heldKeyboard, heldTouch } = withHeld(state.jumpKeyboard, state.jumpTouch, action.source, false);
      return { ...state, jumpHeld: held, jumpKeyboard: heldKeyboard, jumpTouch: heldTouch };
    }

    case "frame":
      // The edge lives exactly one frame.
      return state.jumpPressed ? { ...state, jumpPressed: false } : state;

    case "releaseAll":
      return INITIAL_BRICKRISE_INPUT;

    default:
      return state;
  }
}

/**
 * Collapse to the direction the physics step wants.
 *
 * Holding both directions resolves to neutral rather than to whichever arrived
 * last: last-wins makes a panic press of both keys fling the body in a
 * direction the player did not choose, which on a hazard ledge reads as the
 * game killing you.
 */
export function directionFrom(state: BrickriseInputState): -1 | 0 | 1 {
  if (state.left === state.right) return 0;
  return state.left ? -1 : 1;
}

/** Map a keyboard event code to an action, or null if it is not a game key. */
export function keyboardActionFor(
  code: string,
  phase: "down" | "up",
): BrickriseInputAction | null {
  const source: BrickriseInputSource = "keyboard";
  if (code === "ArrowLeft" || code === "KeyA") {
    return phase === "down"
      ? { type: "moveStart", source, direction: -1 }
      : { type: "moveEnd", source, direction: -1 };
  }
  if (code === "ArrowRight" || code === "KeyD") {
    return phase === "down"
      ? { type: "moveStart", source, direction: 1 }
      : { type: "moveEnd", source, direction: 1 };
  }
  if (code === "Space" || code === "ArrowUp" || code === "KeyW") {
    return phase === "down" ? { type: "jumpDown", source } : { type: "jumpUp", source };
  }
  return null;
}
