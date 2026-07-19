import { describe, expect, it } from "vitest";
import {
  advanceDistance,
  computeScore,
  currentScore,
  endRun,
  fromSaveData,
  initialRunState,
  initialSaveData,
  mergeBest,
  PAPER_GLIDER_SAVE_SCHEMA_VERSION,
  PAPER_GLIDER_SCORE,
  recordRingCollected,
  ringCollectionKey,
} from "@/lib/vector/games/paper-glider/progress";

describe("computeScore", () => {
  it("is zero at zero distance and zero rings", () => {
    expect(computeScore(0, 0)).toBe(0);
  });

  it("grows with distance at the configured rate", () => {
    expect(computeScore(100, 0)).toBe(Math.round(100 * PAPER_GLIDER_SCORE.DISTANCE_PER_POINT));
  });

  it("adds a flat bonus per ring, independent of distance", () => {
    expect(computeScore(0, 3)).toBe(3 * PAPER_GLIDER_SCORE.RING_BONUS);
    expect(computeScore(50, 3) - computeScore(50, 0)).toBe(3 * PAPER_GLIDER_SCORE.RING_BONUS);
  });

  it("is monotonically non-decreasing in both distance and rings", () => {
    expect(computeScore(200, 5)).toBeGreaterThan(computeScore(100, 5));
    expect(computeScore(100, 5)).toBeGreaterThan(computeScore(100, 2));
  });

  it("treats negative or non-finite inputs defensively", () => {
    expect(computeScore(-10, 0)).toBe(0);
    expect(computeScore(0, -5)).toBe(0);
    expect(computeScore(Number.NaN, Number.NaN)).toBe(0);
  });
});

describe("run state", () => {
  it("starts alive with zero progress", () => {
    const state = initialRunState("seed-1");
    expect(state.alive).toBe(true);
    expect(state.distance).toBe(0);
    expect(state.ringsCollected).toBe(0);
    expect(state.collisionReason).toBeNull();
  });

  describe("advanceDistance", () => {
    it("only ever moves distance forward, never backward", () => {
      let state = initialRunState("seed");
      state = advanceDistance(state, 10);
      state = advanceDistance(state, 25);
      expect(state.distance).toBe(25);
      state = advanceDistance(state, 5); // a smaller z than already recorded should not regress it
      expect(state.distance).toBe(25);
    });

    it("is a no-op once the run has ended", () => {
      let state = initialRunState("seed");
      state = endRun(state, "wall");
      const after = advanceDistance(state, 999);
      expect(after).toBe(state);
    });

    it("ignores non-finite input", () => {
      const state = initialRunState("seed");
      expect(advanceDistance(state, Number.NaN)).toBe(state);
    });
  });

  describe("recordRingCollected", () => {
    it("increments the count and records the key", () => {
      let state = initialRunState("seed");
      state = recordRingCollected(state, ringCollectionKey(1, 0));
      expect(state.ringsCollected).toBe(1);
      expect(state.collectedRingKeys).toContain("1:0");
    });

    it("is idempotent — the same key twice counts once", () => {
      let state = initialRunState("seed");
      state = recordRingCollected(state, ringCollectionKey(1, 0));
      state = recordRingCollected(state, ringCollectionKey(1, 0));
      expect(state.ringsCollected).toBe(1);
    });

    it("distinguishes rings by both room and ring index", () => {
      let state = initialRunState("seed");
      state = recordRingCollected(state, ringCollectionKey(1, 0));
      state = recordRingCollected(state, ringCollectionKey(2, 0));
      expect(state.ringsCollected).toBe(2);
    });

    it("is a no-op once the run has ended", () => {
      let state = initialRunState("seed");
      state = endRun(state, "furniture");
      const after = recordRingCollected(state, ringCollectionKey(1, 0));
      expect(after).toBe(state);
    });
  });

  describe("endRun", () => {
    it("marks the run dead and records the reason", () => {
      const state = endRun(initialRunState("seed"), "bounds");
      expect(state.alive).toBe(false);
      expect(state.collisionReason).toBe("bounds");
    });

    it("keeps the FIRST collision reason — ending an already-ended run is a no-op", () => {
      let state = endRun(initialRunState("seed"), "wall");
      state = endRun(state, "furniture");
      expect(state.collisionReason).toBe("wall");
    });

    it("does not alter distance or rings already banked", () => {
      let state = initialRunState("seed");
      state = advanceDistance(state, 40);
      state = recordRingCollected(state, ringCollectionKey(1, 0));
      state = endRun(state, "wall");
      expect(state.distance).toBe(40);
      expect(state.ringsCollected).toBe(1);
    });
  });

  describe("score never decreases mid-run", () => {
    it("holds across a realistic sequence of advances, ring pickups, and a final collision", () => {
      let state = initialRunState("seed");
      let previousScore = currentScore(state);
      const steps: Array<() => void> = [
        () => { state = advanceDistance(state, 10); },
        () => { state = advanceDistance(state, 25); },
        () => { state = recordRingCollected(state, ringCollectionKey(1, 0)); },
        () => { state = advanceDistance(state, 60); },
        () => { state = recordRingCollected(state, ringCollectionKey(1, 0)); }, // duplicate, must not double count
        () => { state = advanceDistance(state, 90); },
        () => { state = recordRingCollected(state, ringCollectionKey(2, 1)); },
        () => { state = endRun(state, "wall"); },
        () => { state = advanceDistance(state, 500); }, // must be inert after death
      ];
      for (const step of steps) {
        step();
        const score = currentScore(state);
        expect(score).toBeGreaterThanOrEqual(previousScore);
        previousScore = score;
      }
    });
  });
});

describe("save data", () => {
  it("starts at zero", () => {
    expect(initialSaveData()).toEqual({
      version: PAPER_GLIDER_SAVE_SCHEMA_VERSION,
      bestScore: 0,
      bestDistance: 0,
      bestRingsCollected: 0,
    });
  });

  describe("mergeBest", () => {
    it("keeps the maximum of each field independently, not just the higher-scoring run wholesale", () => {
      const save = { version: PAPER_GLIDER_SAVE_SCHEMA_VERSION, bestScore: 500, bestDistance: 400, bestRingsCollected: 10 };
      let run = initialRunState("seed");
      run = advanceDistance(run, 100); // worse distance than the existing best
      run = recordRingCollected(run, ringCollectionKey(1, 0));
      run = recordRingCollected(run, ringCollectionKey(1, 1));
      run = recordRingCollected(run, ringCollectionKey(1, 2));
      run = recordRingCollected(run, ringCollectionKey(1, 3));
      run = recordRingCollected(run, ringCollectionKey(1, 4));
      run = recordRingCollected(run, ringCollectionKey(1, 5));
      run = recordRingCollected(run, ringCollectionKey(1, 6));
      run = recordRingCollected(run, ringCollectionKey(1, 7));
      run = recordRingCollected(run, ringCollectionKey(1, 8));
      run = recordRingCollected(run, ringCollectionKey(1, 9));
      run = recordRingCollected(run, ringCollectionKey(1, 10)); // 11 rings — a new ring best, worse distance/score

      const merged = mergeBest(save, run);
      expect(merged.bestDistance).toBe(400); // unchanged: the run's distance was worse
      expect(merged.bestRingsCollected).toBe(11); // updated: the run's ring count was better
      expect(merged.bestScore).toBe(Math.max(500, currentScore(run)));
    });

    it("never decreases an existing best", () => {
      const save = { version: PAPER_GLIDER_SAVE_SCHEMA_VERSION, bestScore: 1000, bestDistance: 900, bestRingsCollected: 20 };
      const run = initialRunState("seed"); // a fresh, empty run
      expect(mergeBest(save, run)).toEqual(save);
    });
  });

  describe("fromSaveData", () => {
    it("round-trips a valid save", () => {
      const save = { version: PAPER_GLIDER_SAVE_SCHEMA_VERSION, bestScore: 250, bestDistance: 200, bestRingsCollected: 4 };
      expect(fromSaveData(save)).toEqual(save);
    });

    it("rejects a mismatched schema version", () => {
      expect(fromSaveData({ version: 999, bestScore: 1, bestDistance: 1, bestRingsCollected: 0 })).toBeNull();
    });

    it("rejects non-objects", () => {
      expect(fromSaveData(null)).toBeNull();
      expect(fromSaveData(undefined)).toBeNull();
      expect(fromSaveData("nope")).toBeNull();
      expect(fromSaveData(42)).toBeNull();
    });

    it("rejects negative or non-finite numeric fields", () => {
      const base = { version: PAPER_GLIDER_SAVE_SCHEMA_VERSION, bestScore: 1, bestDistance: 1, bestRingsCollected: 1 };
      expect(fromSaveData({ ...base, bestScore: -1 })).toBeNull();
      expect(fromSaveData({ ...base, bestDistance: Number.NaN })).toBeNull();
      expect(fromSaveData({ ...base, bestRingsCollected: -1 })).toBeNull();
      expect(fromSaveData({ ...base, bestScore: "500" })).toBeNull();
    });

    it("floors a fractional ring count rather than rejecting it", () => {
      const save = fromSaveData({
        version: PAPER_GLIDER_SAVE_SCHEMA_VERSION,
        bestScore: 1,
        bestDistance: 1,
        bestRingsCollected: 4.9,
      });
      expect(save?.bestRingsCollected).toBe(4);
    });
  });
});
