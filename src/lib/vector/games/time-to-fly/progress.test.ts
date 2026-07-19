import { describe, expect, it } from "vitest";
import { TIME_TO_FLY_LEVEL_COUNT } from "@/lib/vector/games/time-to-fly/constants";
import {
  TIME_TO_FLY_SAVE_SCHEMA_VERSION,
  TIME_TO_FLY_SCORE_STRIDE,
  TIME_TO_FLY_TIME_CEILING,
  advanceElapsed,
  fromPersistedScore,
  fromSaveData,
  initialRunState,
  levelsSolvedCount,
  recordLaunch,
  rememberArrangement,
  runCompleted,
  selectLevel,
  solveLevel,
  toPersistedScore,
  toSaveData,
} from "@/lib/vector/games/time-to-fly/progress";

describe("run state", () => {
  it("starts unsolved on level 1 with nothing on the board", () => {
    const state = initialRunState("seed");
    expect(state.levelIndex).toBe(0);
    expect(state.solved).toHaveLength(TIME_TO_FLY_LEVEL_COUNT);
    expect(state.solved.every((flag) => !flag)).toBe(true);
    expect(state.arrangement).toBeNull();
    expect(runCompleted(state)).toBe(false);
  });

  it("solving is monotone and idempotent", () => {
    let state = solveLevel(initialRunState("seed"), 2);
    expect(state.solved[2]).toBe(true);
    const again = solveLevel(state, 2);
    expect(again).toBe(state); // no-op, not a new object
    state = solveLevel(state, 0);
    expect(levelsSolvedCount(state)).toBe(2);
  });

  it("ignores out-of-range level indices", () => {
    const state = initialRunState("seed");
    expect(solveLevel(state, -1)).toBe(state);
    expect(solveLevel(state, TIME_TO_FLY_LEVEL_COUNT)).toBe(state);
    expect(selectLevel(state, 99)).toBe(state);
  });

  it("completes only when all five levels are solved", () => {
    let state = initialRunState("seed");
    for (let index = 0; index < TIME_TO_FLY_LEVEL_COUNT - 1; index += 1) {
      state = solveLevel(state, index);
    }
    expect(runCompleted(state)).toBe(false);
    state = solveLevel(state, TIME_TO_FLY_LEVEL_COUNT - 1);
    expect(runCompleted(state)).toBe(true);
  });

  it("selecting a level clears the board arrangement", () => {
    let state = rememberArrangement(initialRunState("seed"), [1, 2, 3]);
    expect(state.arrangement).toEqual([1, 2, 3]);
    state = selectLevel(state, 1);
    expect(state.arrangement).toBeNull();
    // Re-selecting the current level is a no-op and keeps the board.
    state = rememberArrangement(state, [4, 5]);
    expect(selectLevel(state, 1)).toBe(state);
  });

  it("counts launches without a cap and ignores non-positive time", () => {
    let state = recordLaunch(recordLaunch(initialRunState("seed")));
    expect(state.launches).toBe(2);
    state = advanceElapsed(state, 100);
    expect(advanceElapsed(state, -5)).toBe(state);
    expect(advanceElapsed(state, Number.NaN)).toBe(state);
    expect(state.elapsedMs).toBe(100);
  });
});

describe("save round-trip", () => {
  it("survives serialise and rehydrate exactly", () => {
    let state = initialRunState("round-trip");
    state = solveLevel(state, 0);
    state = selectLevel(state, 1);
    state = rememberArrangement(state, [3, 7]);
    state = advanceElapsed(recordLaunch(state), 4321);

    const restored = fromSaveData(toSaveData(state));
    expect(restored).toEqual(state);
  });

  it("uses the schema version the manifest declares", () => {
    // registry.ts pins saveSchemaVersion 1 for the manifest; the runtime
    // rejects saves whose schemaVersion disagrees, so this equality is the
    // difference between saves that restore and saves that are silently lost.
    expect(TIME_TO_FLY_SAVE_SCHEMA_VERSION).toBe(1);
    expect(toSaveData(initialRunState("s")).version).toBe(TIME_TO_FLY_SAVE_SCHEMA_VERSION);
  });

  it.each([
    ["null", null],
    ["not an object", 42],
    ["wrong version", { ...toSaveData(initialRunState("s")), version: 2 }],
    ["empty seed", { ...toSaveData(initialRunState("s")), runSeed: "" }],
    ["level index out of range", { ...toSaveData(initialRunState("s")), levelIndex: 9 }],
    ["short solved array", { ...toSaveData(initialRunState("s")), solved: [true] }],
    ["non-boolean solved entry", { ...toSaveData(initialRunState("s")), solved: [1, 0, 0, 0, 0] }],
    ["negative launches", { ...toSaveData(initialRunState("s")), launches: -1 }],
    ["infinite elapsed", { ...toSaveData(initialRunState("s")), elapsedMs: Number.POSITIVE_INFINITY }],
    ["fractional slot", { ...toSaveData(initialRunState("s")), arrangement: [1.5] }],
    ["out-of-range slot", { ...toSaveData(initialRunState("s")), arrangement: [12] }],
  ])("rejects a corrupt save: %s", (_name, raw) => {
    expect(fromSaveData(raw)).toBeNull();
  });
});

describe("persisted score", () => {
  it("always ranks more levels above faster times under a max merge", () => {
    // Four levels solved instantly versus five solved after an hour: the five
    // must win, because the merge is Math.max and the score is the record.
    const four = solveLevel(solveLevel(solveLevel(solveLevel(initialRunState("s"), 0), 1), 2), 3);
    let five = solveLevel(four, 4);
    five = advanceElapsed(five, TIME_TO_FLY_TIME_CEILING * 2);
    expect(toPersistedScore(five)).toBeGreaterThan(toPersistedScore(four));
  });

  it("ranks faster above slower at the same solved count", () => {
    const base = solveLevel(initialRunState("s"), 0);
    const fast = advanceElapsed(base, 60_000);
    const slow = advanceElapsed(base, 600_000);
    expect(toPersistedScore(fast)).toBeGreaterThan(toPersistedScore(slow));
  });

  it("round-trips through the persisted form", () => {
    let state = solveLevel(solveLevel(initialRunState("s"), 0), 1);
    state = advanceElapsed(state, 90_000);
    const parts = fromPersistedScore(toPersistedScore(state));
    expect(parts.levelsSolved).toBe(2);
    expect(parts.elapsedMs).toBe(90_000);
  });

  it("stays inside the runtime event metadata numeric bound", () => {
    // sanitizeVectorRuntimeEvent rejects |value| > 1e12; the maximum possible
    // score must stay well inside it.
    let state = initialRunState("s");
    for (let index = 0; index < TIME_TO_FLY_LEVEL_COUNT; index += 1) state = solveLevel(state, index);
    expect(toPersistedScore(state)).toBeLessThanOrEqual(
      TIME_TO_FLY_LEVEL_COUNT * TIME_TO_FLY_SCORE_STRIDE + TIME_TO_FLY_TIME_CEILING,
    );
    expect(TIME_TO_FLY_LEVEL_COUNT * TIME_TO_FLY_SCORE_STRIDE + TIME_TO_FLY_TIME_CEILING).toBeLessThan(1e12);
  });
});
