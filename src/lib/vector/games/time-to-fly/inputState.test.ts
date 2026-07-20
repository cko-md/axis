import { describe, expect, it } from "vitest";
import {
  TIME_TO_FLY_SLOT_COUNT,
  TIME_TO_FLY_SLOT_UNITS,
} from "@/lib/vector/games/time-to-fly/constants";
import {
  type TimeToFlyInputAction,
  type TimeToFlyInputState,
  createTimeToFlyInput,
  keyboardActionFor,
  nearestSlotTo,
  reduceTimeToFlyInput,
} from "@/lib/vector/games/time-to-fly/inputState";

function reduceAll(
  state: TimeToFlyInputState,
  actions: readonly TimeToFlyInputAction[],
): TimeToFlyInputState {
  return actions.reduce(reduceTimeToFlyInput, state);
}

describe("nearestSlotTo", () => {
  it("snaps every slot's own unit vector back to that slot", () => {
    TIME_TO_FLY_SLOT_UNITS.forEach((unit, slot) => {
      expect(nearestSlotTo(unit)).toBe(slot);
    });
  });

  it("snaps an off-lattice angle to the closer neighbour", () => {
    // 10 degrees off slot 0, well inside its 15-degree half-width.
    expect(nearestSlotTo({ x: 0.9848, y: 0.1736 })).toBe(0);
    // 20 degrees is past the boundary toward slot 1 (30 degrees).
    expect(nearestSlotTo({ x: 0.9397, y: 0.342 })).toBe(1);
  });

  it("is magnitude-independent — a long drag and a short drag agree", () => {
    expect(nearestSlotTo({ x: 500, y: 90 })).toBe(nearestSlotTo({ x: 5, y: 0.9 }));
  });

  it("refuses a zero vector rather than inventing a direction", () => {
    expect(nearestSlotTo({ x: 0, y: 0 })).toBeNull();
  });
});

describe("drag: continuous under the finger, discrete on release", () => {
  it("follows the pointer during the drag without touching the arrangement", () => {
    let state = createTimeToFlyInput([0, 3]);
    state = reduceAll(state, [
      { type: "dragStart", planetIndex: 1, offset: { x: 10, y: 0 } },
      { type: "dragMove", offset: { x: 30, y: 40 } },
    ]);
    expect(state.draggingPlanet).toBe(1);
    // Normalized, continuous: not snapped to any lattice direction.
    expect(state.dragVector).toEqual({ x: 0.6, y: 0.8 });
    // The committed state is untouched until release.
    expect(state.arrangement).toEqual([0, 3]);
  });

  it("commits to the nearest slot on release", () => {
    let state = createTimeToFlyInput([0, 3]);
    state = reduceAll(state, [
      { type: "dragStart", planetIndex: 0, offset: { x: 10, y: 0 } },
      { type: "dragMove", offset: { x: 0, y: -50 } }, // due north = slot 9
      { type: "dragEnd" },
    ]);
    expect(state.arrangement).toEqual([9, 3]);
    expect(state.draggingPlanet).toBeNull();
    expect(state.dragVector).toBeNull();
  });

  it("cancelling a drag leaves the committed slot alone", () => {
    let state = createTimeToFlyInput([5]);
    state = reduceAll(state, [
      { type: "dragStart", planetIndex: 0, offset: { x: 0, y: 50 } },
      { type: "dragMove", offset: { x: -50, y: 0 } },
      { type: "dragCancel" },
    ]);
    expect(state.arrangement).toEqual([5]);
    expect(state.draggingPlanet).toBeNull();
  });

  it("opens a centre-touch drag at the planet's current slot", () => {
    let state = createTimeToFlyInput([4]);
    state = reduceTimeToFlyInput(state, { type: "dragStart", planetIndex: 0, offset: { x: 0, y: 0 } });
    expect(state.dragVector).toEqual(TIME_TO_FLY_SLOT_UNITS[4]);
  });

  it("keeps the previous direction when the pointer crosses the centre", () => {
    let state = createTimeToFlyInput([0]);
    state = reduceAll(state, [
      { type: "dragStart", planetIndex: 0, offset: { x: 10, y: 0 } },
      { type: "dragMove", offset: { x: 0, y: 0 } },
    ]);
    expect(state.dragVector).toEqual({ x: 1, y: 0 });
  });

  it("ignores drags on planets that do not exist", () => {
    const state = createTimeToFlyInput([0]);
    expect(reduceTimeToFlyInput(state, { type: "dragStart", planetIndex: 5, offset: { x: 1, y: 0 } })).toBe(state);
    expect(reduceTimeToFlyInput(state, { type: "dragStart", planetIndex: -1, offset: { x: 1, y: 0 } })).toBe(state);
  });
});

describe("keyboard: rotation and selection", () => {
  it("rotates the selected planet one slot and wraps", () => {
    let state = createTimeToFlyInput([TIME_TO_FLY_SLOT_COUNT - 1, 2]);
    state = reduceTimeToFlyInput(state, { type: "rotateSelected", direction: 1 });
    expect(state.arrangement).toEqual([0, 2]);
    state = reduceTimeToFlyInput(state, { type: "rotateSelected", direction: -1 });
    expect(state.arrangement).toEqual([TIME_TO_FLY_SLOT_COUNT - 1, 2]);
  });

  it("cycles selection with wraparound", () => {
    let state = createTimeToFlyInput([0, 0, 0]);
    state = reduceTimeToFlyInput(state, { type: "cycleSelection", direction: -1 });
    expect(state.selectedPlanet).toBe(2);
    state = reduceTimeToFlyInput(state, { type: "cycleSelection", direction: 1 });
    expect(state.selectedPlanet).toBe(0);
  });

  it("a drag claims selection, and keyboard rotation defers to an active drag", () => {
    let state = createTimeToFlyInput([0, 0]);
    state = reduceTimeToFlyInput(state, { type: "dragStart", planetIndex: 1, offset: { x: 1, y: 0 } });
    expect(state.selectedPlanet).toBe(1);
    const during = reduceTimeToFlyInput(state, { type: "rotateSelected", direction: 1 });
    expect(during.arrangement).toEqual([0, 0]);
  });

  it("maps game keys and nothing else", () => {
    expect(keyboardActionFor("Space", "down")).toEqual({ type: "launch" });
    expect(keyboardActionFor("ArrowLeft", "down")).toEqual({ type: "rotateSelected", direction: -1 });
    expect(keyboardActionFor("ArrowRight", "down")).toEqual({ type: "rotateSelected", direction: 1 });
    expect(keyboardActionFor("ArrowUp", "down")).toEqual({ type: "cycleSelection", direction: -1 });
    expect(keyboardActionFor("ArrowDown", "down")).toEqual({ type: "cycleSelection", direction: 1 });
    expect(keyboardActionFor("Space", "up")).toBeNull();
    expect(keyboardActionFor("KeyQ", "down")).toBeNull();
    // Tab must NOT be claimed: the shell preventDefaults every claimed code, so
    // returning an action here would trap keyboard focus (WCAG 2.1.2).
    expect(keyboardActionFor("Tab", "down")).toBeNull();
  });
});

describe("launch edge and phase", () => {
  it("raises the edge once and clears it on the frame boundary", () => {
    let state = createTimeToFlyInput([0]);
    state = reduceTimeToFlyInput(state, { type: "launch" });
    expect(state.launchRequested).toBe(true);
    // Keyboard auto-repeat must not stack edges.
    const repeated = reduceTimeToFlyInput(state, { type: "launch" });
    expect(repeated).toBe(state);
    state = reduceTimeToFlyInput(state, { type: "frame" });
    expect(state.launchRequested).toBe(false);
  });

  it("refuses to launch mid-drag", () => {
    let state = createTimeToFlyInput([0]);
    state = reduceTimeToFlyInput(state, { type: "dragStart", planetIndex: 0, offset: { x: 1, y: 0 } });
    state = reduceTimeToFlyInput(state, { type: "launch" });
    expect(state.launchRequested).toBe(false);
  });

  it("locks the board while flying — planets move only by PRE-launch drag", () => {
    let state = createTimeToFlyInput([2]);
    state = reduceTimeToFlyInput(state, { type: "flightStarted" });
    expect(state.phase).toBe("flying");
    const dragged = reduceAll(state, [
      { type: "dragStart", planetIndex: 0, offset: { x: 0, y: 50 } },
      { type: "dragEnd" },
    ]);
    expect(dragged.arrangement).toEqual([2]);
    const rotated = reduceTimeToFlyInput(state, { type: "rotateSelected", direction: 1 });
    expect(rotated.arrangement).toEqual([2]);
    const launched = reduceTimeToFlyInput(state, { type: "launch" });
    expect(launched.launchRequested).toBe(false);
  });

  it("retry preserves the arrangement as launched; reset restores the opening", () => {
    let state = createTimeToFlyInput([1, 2]);
    state = reduceAll(state, [
      { type: "dragStart", planetIndex: 0, offset: { x: 0, y: 50 } }, // slot 3
      { type: "dragEnd" },
      { type: "launch" },
      { type: "flightStarted" },
      { type: "flightEnded" },
    ]);
    // Back to aiming with the board exactly as launched.
    expect(state.phase).toBe("aiming");
    expect(state.arrangement).toEqual([3, 2]);
    // The explicit reset is the one path back to the seeded opening.
    state = reduceTimeToFlyInput(state, { type: "reset", arrangement: [1, 2] });
    expect(state.arrangement).toEqual([1, 2]);
  });

  it("releaseAll clears transient state but never the board", () => {
    let state = createTimeToFlyInput([4]);
    state = reduceAll(state, [
      { type: "dragStart", planetIndex: 0, offset: { x: 0, y: 50 } },
      { type: "launch" },
      { type: "releaseAll" },
    ]);
    expect(state.draggingPlanet).toBeNull();
    expect(state.launchRequested).toBe(false);
    expect(state.arrangement).toEqual([4]);
  });
});
