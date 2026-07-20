/**
 * Paper Glider input — one normalized state machine for pointer, touch, and
 * keyboard steering.
 *
 * Every raw input source reduces into this single state, and the shell derives
 * exactly one `SteerTarget` per fixed step from it (`steerTargetFrom`), so the
 * physics cannot tell a mouse from a thumb from an arrow key and there is only
 * one set of steering rules to test — the same reason Brickrise reduces
 * keyboard and touch into one state machine.
 *
 * The DOM adapter in game.ts owns pixel space: it maps client coordinates to
 * the normalized [-1, 1] values this module stores (rect-relative, linear
 * arithmetic only). This module owns meaning: which source is steering, how
 * keys collapse, and how the normalized state becomes a room-space target.
 *
 * Determinism note: `steerTargetFrom` feeds the simulation, so it uses only
 * + - * / and comparisons — the dead zone compares SQUARED magnitudes rather
 * than taking a root, and the key collapse is pure boolean arithmetic.
 */

import { STEER_ARRIVE_RADIUS, type SteerTarget } from "@/lib/vector/games/paper-glider/physics";
import { PAPER_GLIDER_LEVEL_CONFIG } from "@/lib/vector/games/paper-glider/level";

export type PaperGliderSteerKey = "left" | "right" | "up" | "down";

export type PaperGliderInputAction =
  /** Pointer or touch moved over the surface; nx/ny are normalized [-1, 1]. */
  | { type: "pointerSteer"; nx: number; ny: number }
  /** The steering pointer left the surface or lifted; steering falls back to keys, then to holding course. */
  | { type: "pointerRelease" }
  | { type: "keyDown"; key: PaperGliderSteerKey }
  | { type: "keyUp"; key: PaperGliderSteerKey }
  /** Focus/visibility loss. Releases everything so the glider cannot drift while unwatched. */
  | { type: "releaseAll" };

export type PaperGliderInputState = Readonly<{
  /** True while a pointer/touch owns steering; its normalized position wins over keys. */
  pointerActive: boolean;
  /** Normalized [-1, 1] steering position. Meaningful only while pointerActive. */
  steerX: number;
  steerY: number;
  keyLeft: boolean;
  keyRight: boolean;
  keyUp: boolean;
  keyDown: boolean;
}>;

export const INITIAL_PAPER_GLIDER_INPUT: PaperGliderInputState = Object.freeze({
  pointerActive: false,
  steerX: 0,
  steerY: 0,
  keyLeft: false,
  keyRight: false,
  keyUp: false,
  keyDown: false,
});

export const PAPER_GLIDER_INPUT_TUNING = Object.freeze({
  /**
   * Normalized radius around the surface centre inside which pointer jitter
   * reads as exactly centre. Compared as a squared magnitude so deriving a
   * target never needs a root.
   */
  POINTER_DEAD_ZONE: 0.05,
  /**
   * How far ahead of the body (in world units) a held key places the target.
   * DERIVED from the physics rather than hand-tuned: anything beyond
   * STEER_ARRIVE_RADIUS gets full steering authority (the "arrive" easing only
   * engages inside that radius), and because the target tracks the body it
   * stays that far ahead for as long as the key is held — so a held key means
   * full-speed steering, never a partial-authority crawl.
   */
  KEYBOARD_STEER_LEAD: STEER_ARRIVE_RADIUS * 2,
});

export function reducePaperGliderInput(
  state: PaperGliderInputState,
  action: PaperGliderInputAction,
): PaperGliderInputState {
  switch (action.type) {
    case "pointerSteer":
      return { ...state, pointerActive: true, steerX: action.nx, steerY: action.ny };

    case "pointerRelease":
      return { ...state, pointerActive: false, steerX: 0, steerY: 0 };

    case "keyDown":
      switch (action.key) {
        case "left":
          return { ...state, keyLeft: true };
        case "right":
          return { ...state, keyRight: true };
        case "up":
          return { ...state, keyUp: true };
        case "down":
          return { ...state, keyDown: true };
      }
      return state;

    case "keyUp":
      switch (action.key) {
        case "left":
          return { ...state, keyLeft: false };
        case "right":
          return { ...state, keyRight: false };
        case "up":
          return { ...state, keyUp: false };
        case "down":
          return { ...state, keyDown: false };
      }
      return state;

    case "releaseAll":
      return INITIAL_PAPER_GLIDER_INPUT;

    default:
      return state;
  }
}

/**
 * Map a keyboard event code to the steering key it drives, or null for any
 * key this game does not use. Null is load-bearing: the shell claims (and
 * preventDefaults) ONLY codes mapped here, so Tab keeps moving focus and
 * Escape keeps reaching the host's pause binding (WCAG 2.1.2 — no keyboard
 * trap).
 */
export function keyboardSteerKeyFor(code: string): PaperGliderSteerKey | null {
  switch (code) {
    case "ArrowLeft":
    case "KeyA":
      return "left";
    case "ArrowRight":
    case "KeyD":
      return "right";
    case "ArrowUp":
    case "KeyW":
      return "up";
    case "ArrowDown":
    case "KeyS":
      return "down";
    default:
      return null;
  }
}

/**
 * Derive the one SteerTarget the simulation consumes this step.
 *
 * Precedence: an active pointer wins (absolute position steering — the
 * normalized surface position maps linearly onto the room cross-section);
 * otherwise held keys steer relative to the body (a target held
 * KEYBOARD_STEER_LEAD ahead, opposing keys collapsing to neutral exactly as
 * Brickrise's directionFrom does, so a panic press of both directions never
 * flings the glider somewhere the player did not choose); otherwise the target
 * IS the body — under "arrive" dynamics that decelerates lateral velocity to
 * a stop, i.e. no input means hold course, not seek the room centre.
 *
 * The pointer target is deliberately NOT clamped beyond the [-1, 1] input
 * range: `stepGlider`'s bounded acceleration makes any target safe to pursue,
 * and steering into a wall is an ordinary, honest way to lose.
 */
export function steerTargetFrom(
  state: PaperGliderInputState,
  body: Readonly<{ x: number; y: number }>,
): SteerTarget {
  const C = PAPER_GLIDER_LEVEL_CONFIG;
  const T = PAPER_GLIDER_INPUT_TUNING;

  if (state.pointerActive) {
    const magnitudeSquared = state.steerX * state.steerX + state.steerY * state.steerY;
    if (magnitudeSquared < T.POINTER_DEAD_ZONE * T.POINTER_DEAD_ZONE) {
      return { x: 0, y: 0 };
    }
    return { x: state.steerX * C.ROOM_HALF_WIDTH, y: state.steerY * C.ROOM_HALF_HEIGHT };
  }

  const keyX = state.keyLeft === state.keyRight ? 0 : state.keyLeft ? -1 : 1;
  const keyY = state.keyUp === state.keyDown ? 0 : state.keyUp ? 1 : -1;
  if (keyX !== 0 || keyY !== 0) {
    return { x: body.x + keyX * T.KEYBOARD_STEER_LEAD, y: body.y + keyY * T.KEYBOARD_STEER_LEAD };
  }

  return { x: body.x, y: body.y };
}
