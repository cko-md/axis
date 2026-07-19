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
}>;

export const INITIAL_BRICKRISE_INPUT: BrickriseInputState = Object.freeze({
  left: false,
  right: false,
  jumpHeld: false,
  jumpPressed: false,
});

export function reduceBrickriseInput(
  state: BrickriseInputState,
  action: BrickriseInputAction,
): BrickriseInputState {
  switch (action.type) {
    case "moveStart":
      return action.direction === -1 ? { ...state, left: true } : { ...state, right: true };

    case "moveEnd":
      return action.direction === -1 ? { ...state, left: false } : { ...state, right: false };

    case "jumpDown":
      // Re-pressing while already held (keyboard auto-repeat, or a second
      // finger) must not re-arm the edge — that would let a held key produce a
      // jump on every frame the buffer expired.
      if (state.jumpHeld) return state;
      return { ...state, jumpHeld: true, jumpPressed: true };

    case "jumpUp":
      return { ...state, jumpHeld: false };

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
