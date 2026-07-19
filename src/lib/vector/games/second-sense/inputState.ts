/**
 * One normalized hold-interaction state machine shared by keyboard, pointer,
 * and touch input. The three DOM adapters in game.ts translate their native
 * events (keydown/keyup, pointerdown/pointerup, touchstart/touchend) into the
 * same two intents — holdStart / holdEnd — before they ever reach this
 * reducer, so the trial logic never has to special-case an input kind.
 *
 * Pure and DOM-free: fully unit-testable without a browser.
 */

export type SecondSenseInputPhase =
  | "idle"
  | "demonstrating"
  | "armed"
  | "holding"
  | "released";

export type SecondSenseInputState = {
  phase: SecondSenseInputPhase;
  holdStartedAtMs: number | null;
  heldForMs: number | null;
};

export type SecondSenseInputEvent =
  | { type: "trialStart" }
  | { type: "demoComplete" }
  | { type: "holdStart"; atMs: number }
  | { type: "holdEnd"; atMs: number }
  | { type: "reset" };

export const INITIAL_SECOND_SENSE_INPUT_STATE: SecondSenseInputState = {
  phase: "idle",
  holdStartedAtMs: null,
  heldForMs: null,
};

/**
 * Advance the input state machine by exactly one event. Invalid transitions
 * (a duplicate holdStart while already holding, a holdEnd with no matching
 * holdStart, an event arriving after the trial has already been scored) are
 * ignored and return the same state unchanged — callers can dispatch
 * defensively from real DOM events (which can double-fire, e.g. keyboard
 * auto-repeat, or arrive out of order) without corrupting a trial.
 */
export function reduceSecondSenseInput(
  state: SecondSenseInputState,
  event: SecondSenseInputEvent,
): SecondSenseInputState {
  switch (event.type) {
    case "trialStart":
      if (state.phase !== "idle" && state.phase !== "released") return state;
      return { phase: "demonstrating", holdStartedAtMs: null, heldForMs: null };

    case "demoComplete":
      if (state.phase !== "demonstrating") return state;
      return { ...state, phase: "armed" };

    case "holdStart":
      if (state.phase !== "armed") return state;
      return { phase: "holding", holdStartedAtMs: event.atMs, heldForMs: null };

    case "holdEnd":
      if (state.phase !== "holding" || state.holdStartedAtMs === null) return state;
      return {
        phase: "released",
        holdStartedAtMs: state.holdStartedAtMs,
        heldForMs: Math.max(0, event.atMs - state.holdStartedAtMs),
      };

    case "reset":
      return INITIAL_SECOND_SENSE_INPUT_STATE;

    default:
      return state;
  }
}

export function isSecondSenseHolding(state: SecondSenseInputState): boolean {
  return state.phase === "holding";
}
