/**
 * Time to Fly — one normalized input state machine for keyboard, pointer and
 * touch. Pure, DOM-free.
 *
 * The binding spec grants exactly one pre-launch verb — drag a planet around
 * its fixed orbit — plus launch. When those arrive from three input sources
 * handled separately they drift: touch gains a commit behaviour the mouse
 * lacks, or a keyboard rotation skips the animation a drag gets. Every source
 * reduces into this one machine, so the simulation cannot tell a thumb from a
 * mouse from an arrow key, and there is only one set of rules to test.
 *
 * The machine OWNS the pre-launch arrangement. That is deliberate: the
 * arrangement is precisely the player-editable state, and the two spec
 * promises about it — "retry preserves that level's randomized starting
 * positions" and ADR-0006's "retry preserves the arrangement as launched" —
 * are statements about how this machine transitions, testable right here.
 *
 * A drag is CONTINUOUS while the finger is down (dragVector follows the
 * pointer for the renderer) and commits to a discrete slot only on release.
 * The committed state is a slot index, never an angle — see orbit.ts for why
 * that distinction carries the whole determinism story.
 */

import {
  TIME_TO_FLY_SLOT_COUNT,
  TIME_TO_FLY_SLOT_UNITS,
  type TimeToFlyVector,
} from "@/lib/vector/games/time-to-fly/constants";
import { normalizeSlot, type TimeToFlyArrangement } from "@/lib/vector/games/time-to-fly/orbit";

export type TimeToFlyInputPhase = "aiming" | "flying";

export type TimeToFlyInputState = Readonly<{
  phase: TimeToFlyInputPhase;
  /** One slot per planet — the entire player-controlled state. */
  arrangement: TimeToFlyArrangement;
  /** Planet under an active drag, or null. */
  draggingPlanet: number | null;
  /**
   * Unit vector from the dragged planet's orbit centre toward the pointer,
   * for continuous rendering during the drag. Never read by the simulation —
   * only the committed slot is.
   */
  dragVector: TimeToFlyVector | null;
  /** Keyboard focus for slot rotation and cycling. */
  selectedPlanet: number;
  /** EDGE: a launch was requested this frame. Cleared by "frame". */
  launchRequested: boolean;
}>;

export type TimeToFlyInputAction =
  /** Pointer or touch lands on a planet. `offset` is pointer minus that planet's orbit centre, in world units. */
  | { type: "dragStart"; planetIndex: number; offset: TimeToFlyVector }
  | { type: "dragMove"; offset: TimeToFlyVector }
  /** Release: commit the dragged planet to its nearest slot. */
  | { type: "dragEnd" }
  /** Abort the drag without committing (pointer capture lost, blur). */
  | { type: "dragCancel" }
  | { type: "selectPlanet"; planetIndex: number }
  | { type: "cycleSelection"; direction: -1 | 1 }
  /** Keyboard: rotate the selected planet one slot around its orbit. */
  | { type: "rotateSelected"; direction: -1 | 1 }
  /** Launch button or Space. */
  | { type: "launch" }
  /** Advance one frame: clears edges. Dispatched exactly once per step. */
  | { type: "frame" }
  /** The simulation confirmed the craft is away. */
  | { type: "flightStarted" }
  /** The flight resolved. Retry preserves the arrangement AS LAUNCHED. */
  | { type: "flightEnded" }
  /** Explicit reset: restore the level's seeded starting arrangement. */
  | { type: "reset"; arrangement: TimeToFlyArrangement }
  /** Focus/visibility loss. Cancels transient state, keeps the board. */
  | { type: "releaseAll" };

export function createTimeToFlyInput(arrangement: TimeToFlyArrangement): TimeToFlyInputState {
  return {
    phase: "aiming",
    arrangement: [...arrangement],
    draggingPlanet: null,
    dragVector: null,
    selectedPlanet: 0,
    launchRequested: false,
  };
}

/**
 * The slot whose lattice direction best matches a drag vector: the argmax of
 * the dot product over the twelve hardcoded slot units. Comparisons and
 * multiplication only — the drag may be an arbitrary continuous angle, but no
 * transcendental is needed to snap it. Ties resolve to the lowest slot index,
 * deterministically. A zero vector returns null: it points nowhere.
 */
export function nearestSlotTo(vector: TimeToFlyVector): number | null {
  if (vector.x === 0 && vector.y === 0) return null;
  let bestSlot = 0;
  let bestDot = Number.NEGATIVE_INFINITY;
  for (let slot = 0; slot < TIME_TO_FLY_SLOT_COUNT; slot += 1) {
    const unit = TIME_TO_FLY_SLOT_UNITS[slot];
    const dot = vector.x * unit.x + vector.y * unit.y;
    if (dot > bestDot) {
      bestDot = dot;
      bestSlot = slot;
    }
  }
  return bestSlot;
}

function unitOf(vector: TimeToFlyVector): TimeToFlyVector | null {
  const length = Math.sqrt(vector.x * vector.x + vector.y * vector.y);
  if (length === 0) return null;
  return { x: vector.x / length, y: vector.y / length };
}

export function reduceTimeToFlyInput(
  state: TimeToFlyInputState,
  action: TimeToFlyInputAction,
): TimeToFlyInputState {
  switch (action.type) {
    case "dragStart": {
      // Planets move only BEFORE launch — the one non-negotiable in the spec.
      if (state.phase !== "aiming") return state;
      if (
        !Number.isInteger(action.planetIndex)
        || action.planetIndex < 0
        || action.planetIndex >= state.arrangement.length
      ) {
        return state;
      }
      // A touch that lands dead on the orbit centre has no direction yet;
      // open the drag at the planet's current slot so the renderer never
      // snaps to an arbitrary angle.
      const vector = unitOf(action.offset)
        ?? TIME_TO_FLY_SLOT_UNITS[normalizeSlot(state.arrangement[action.planetIndex])];
      return {
        ...state,
        draggingPlanet: action.planetIndex,
        dragVector: vector,
        selectedPlanet: action.planetIndex,
      };
    }

    case "dragMove": {
      if (state.draggingPlanet === null) return state;
      const vector = unitOf(action.offset);
      // Crossing the exact centre keeps the previous direction rather than
      // jumping: the planet must stay under the finger, not teleport.
      if (!vector) return state;
      return { ...state, dragVector: vector };
    }

    case "dragEnd": {
      if (state.draggingPlanet === null) return state;
      const slot = state.dragVector ? nearestSlotTo(state.dragVector) : null;
      if (slot === null) {
        return { ...state, draggingPlanet: null, dragVector: null };
      }
      const arrangement = state.arrangement.map((current, index) =>
        index === state.draggingPlanet ? slot : current,
      );
      return { ...state, arrangement, draggingPlanet: null, dragVector: null };
    }

    case "dragCancel":
      if (state.draggingPlanet === null) return state;
      return { ...state, draggingPlanet: null, dragVector: null };

    case "selectPlanet": {
      if (
        !Number.isInteger(action.planetIndex)
        || action.planetIndex < 0
        || action.planetIndex >= state.arrangement.length
      ) {
        return state;
      }
      return { ...state, selectedPlanet: action.planetIndex };
    }

    case "cycleSelection": {
      const count = state.arrangement.length;
      if (count === 0) return state;
      const next = (state.selectedPlanet + action.direction + count) % count;
      return { ...state, selectedPlanet: next };
    }

    case "rotateSelected": {
      if (state.phase !== "aiming") return state;
      // A drag in progress owns the planet; keyboard rotation would fight it.
      if (state.draggingPlanet !== null) return state;
      const arrangement = state.arrangement.map((current, index) =>
        index === state.selectedPlanet ? normalizeSlot(current + action.direction) : current,
      );
      return { ...state, arrangement };
    }

    case "launch":
      if (state.phase !== "aiming") return state;
      // Mid-drag the player is still adjusting; launching under their finger
      // would commit a slot they never chose.
      if (state.draggingPlanet !== null) return state;
      if (state.launchRequested) return state;
      return { ...state, launchRequested: true };

    case "frame":
      // The edge lives exactly one frame.
      return state.launchRequested ? { ...state, launchRequested: false } : state;

    case "flightStarted":
      if (state.phase === "flying") return state;
      return { ...state, phase: "flying", draggingPlanet: null, dragVector: null, launchRequested: false };

    case "flightEnded":
      // Retry preserves the arrangement as launched (ADR-0006): the board is
      // NOT reset here, only the phase returns to aiming.
      if (state.phase === "aiming") return state;
      return { ...state, phase: "aiming" };

    case "reset":
      // The explicit reset is the one path back to the seeded opening.
      if (state.phase !== "aiming") return state;
      return {
        ...state,
        arrangement: [...action.arrangement],
        draggingPlanet: null,
        dragVector: null,
        launchRequested: false,
      };

    case "releaseAll":
      return { ...state, draggingPlanet: null, dragVector: null, launchRequested: false };

    default:
      return state;
  }
}

/** Map a keyboard event code to an action, or null if it is not a game key. */
export function keyboardActionFor(
  code: string,
  phase: "down" | "up",
): TimeToFlyInputAction | null {
  if (phase !== "down") return null;
  if (code === "Space") return { type: "launch" };
  if (code === "ArrowLeft") return { type: "rotateSelected", direction: -1 };
  if (code === "ArrowRight") return { type: "rotateSelected", direction: 1 };
  if (code === "ArrowUp") return { type: "cycleSelection", direction: -1 };
  if (code === "ArrowDown") return { type: "cycleSelection", direction: 1 };
  // Tab is deliberately NOT a game key. The shell preventDefaults every code
  // this returns an action for, so claiming Tab would trap keyboard focus on
  // the play surface (WCAG 2.1.2). Arrow Up/Down already cycle the selection,
  // so nothing is lost by letting Tab move focus as normal.
  return null;
}
