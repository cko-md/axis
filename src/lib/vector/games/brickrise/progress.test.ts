import { describe, expect, it } from "vitest";
import {
  BRICKRISE_SAVE_SCHEMA_VERSION,
  advanceElapsed,
  completeRun,
  fromPersistedScore,
  fromSaveData,
  initialRunState,
  recordDeath,
  reachCheckpoint,
  respawnPosition,
  toPersistedScore,
  toSaveData,
} from "@/lib/vector/games/brickrise/progress";

const LEVEL = {
  spawn: { x: 480, y: 3300 },
  checkpoints: [
    { index: 0, x: 200, y: 2800 },
    { index: 1, x: 700, y: 2270 },
    { index: 2, x: 350, y: 1740 },
  ],
};

describe("checkpoint progression", () => {
  it("records the first checkpoint reached", () => {
    const state = reachCheckpoint(initialRunState("s"), 0);
    expect(state.checkpointIndex).toBe(0);
  });

  // The invariant that matters: a checkpoint is a floor of progress, never a
  // ceiling. Re-touching a lower checkpoint after a higher one must not send
  // the next respawn backwards.
  it("never moves progress backwards", () => {
    let state = initialRunState("s");
    state = reachCheckpoint(state, 2);
    state = reachCheckpoint(state, 0);
    state = reachCheckpoint(state, 1);
    expect(state.checkpointIndex).toBe(2);
  });

  it("ignores a malformed checkpoint index rather than corrupting progress", () => {
    let state = reachCheckpoint(initialRunState("s"), 1);
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      state = reachCheckpoint(state, bad);
    }
    expect(state.checkpointIndex).toBe(1);
  });
});

describe("respawn", () => {
  it("returns to spawn before any checkpoint", () => {
    expect(respawnPosition(initialRunState("s"), LEVEL)).toEqual(LEVEL.spawn);
  });

  it("returns to the highest checkpoint reached", () => {
    const state = reachCheckpoint(initialRunState("s"), 1);
    expect(respawnPosition(state, LEVEL)).toEqual({ x: 700, y: 2270 });
  });

  // A save that outlived a level change must cost progress rather than place
  // the body inside geometry.
  it("falls back to spawn when the saved checkpoint no longer exists", () => {
    const state = reachCheckpoint(initialRunState("s"), 99);
    expect(respawnPosition(state, LEVEL)).toEqual(LEVEL.spawn);
  });
});

describe("deaths and timing", () => {
  it("retains checkpoint progress across a death", () => {
    let state = reachCheckpoint(initialRunState("s"), 1);
    state = recordDeath(state);
    expect(state.deaths).toBe(1);
    expect(state.checkpointIndex).toBe(1);
  });

  it("accumulates elapsed time and ignores nonsense deltas", () => {
    let state = advanceElapsed(initialRunState("s"), 1000);
    state = advanceElapsed(state, -50);
    state = advanceElapsed(state, Number.NaN);
    state = advanceElapsed(state, 500);
    expect(state.elapsedMs).toBe(1500);
  });
});

describe("save round-trip", () => {
  it("restores a run exactly", () => {
    let state = initialRunState("seed-x");
    state = reachCheckpoint(state, 2);
    state = recordDeath(state);
    state = advanceElapsed(state, 91_000);
    state = completeRun(state);

    expect(fromSaveData(toSaveData(state))).toEqual(state);
  });

  it("restores a run that has not reached a checkpoint", () => {
    const state = advanceElapsed(initialRunState("seed-y"), 250);
    expect(fromSaveData(toSaveData(state))).toEqual(state);
  });

  // Anything unrecognised must start a fresh run, never a half-restored one.
  it("rejects corrupt, foreign, or future-versioned saves", () => {
    const valid = toSaveData(reachCheckpoint(initialRunState("s"), 1));
    for (const bad of [
      null,
      undefined,
      "not an object",
      42,
      {},
      { ...valid, version: BRICKRISE_SAVE_SCHEMA_VERSION + 1 },
      { ...valid, version: undefined },
      { ...valid, seed: "" },
      { ...valid, seed: 5 },
      { ...valid, deaths: -1 },
      { ...valid, deaths: Number.NaN },
      { ...valid, elapsedMs: -1 },
      { ...valid, completed: "yes" },
      { ...valid, checkpointIndex: -2 },
      { ...valid, checkpointIndex: 1.5 },
      { ...valid, checkpointIndex: "1" },
    ]) {
      expect(fromSaveData(bad), `expected null for ${JSON.stringify(bad)}`).toBeNull();
    }
  });

  it("never throws on hostile input", () => {
    for (const bad of [Symbol("x"), () => {}, [], new Map()]) {
      expect(() => fromSaveData(bad)).not.toThrow();
    }
  });
});

describe("score transform", () => {
  // The shared VECTOR contract merges bests with Math.max, so a FASTER summit
  // must encode to a LARGER number or every stored best decodes to garbage.
  it("makes a faster summit score higher", () => {
    expect(toPersistedScore(60_000)).toBeGreaterThan(toPersistedScore(120_000));
  });

  it("round-trips elapsed time", () => {
    for (const ms of [0, 1, 1000, 180_000, 3_599_999]) {
      expect(fromPersistedScore(toPersistedScore(ms))).toBe(ms);
    }
  });

  it("never produces a negative score for an absurdly long run", () => {
    expect(toPersistedScore(99_999_999)).toBe(0);
  });
});
