import { describe, expect, it } from "vitest";
import {
  concentrationMaxWeightFromBps,
  concentrationMaxWeightFromSnapshot,
  normalizeConcentrationMaxWeight,
} from "./concentrationCheck";

describe("concentration profile inputs", () => {
  it("converts integer basis points deterministically", () => {
    expect(concentrationMaxWeightFromBps(2000)).toBe(0.2);
    expect(concentrationMaxWeightFromBps(100)).toBe(0.01);
    expect(concentrationMaxWeightFromBps(20.5)).toBeNull();
    expect(concentrationMaxWeightFromBps(10001)).toBeNull();
  });

  it("rejects unsafe request weights instead of accepting negative or >100% thresholds", () => {
    expect(normalizeConcentrationMaxWeight(0.3)).toBe(0.3);
    expect(normalizeConcentrationMaxWeight(0)).toBeNull();
    expect(normalizeConcentrationMaxWeight(-0.1)).toBeNull();
    expect(normalizeConcentrationMaxWeight(1.01)).toBeNull();
    expect(normalizeConcentrationMaxWeight(Number.NaN)).toBeNull();
  });

  it("replays a valid snapshotted weight and fails closed to the legacy default", () => {
    expect(concentrationMaxWeightFromSnapshot({ maxWeight: 0.2 })).toBe(0.2);
    expect(concentrationMaxWeightFromSnapshot({ maxWeight: -1 })).toBe(0.25);
    expect(concentrationMaxWeightFromSnapshot({ maxWeight: 2 })).toBe(0.25);
  });
});
