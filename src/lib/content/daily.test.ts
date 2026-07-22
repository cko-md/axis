import { describe, expect, it } from "vitest";
import { localDayNumber, localWeekNumber, seededIndex } from "@/lib/content/daily";

describe("localDayNumber", () => {
  it("rolls over at local midnight, not UTC midnight", () => {
    const beforeMidnight = new Date(2026, 6, 21, 23, 59, 0);
    const afterMidnight = new Date(2026, 6, 22, 0, 1, 0);
    expect(localDayNumber(afterMidnight)).toBe(localDayNumber(beforeMidnight) + 1);
  });

  it("is stable across a single local day", () => {
    const morning = new Date(2026, 6, 22, 6, 0, 0);
    const night = new Date(2026, 6, 22, 23, 0, 0);
    expect(localDayNumber(morning)).toBe(localDayNumber(night));
  });
});

describe("localWeekNumber", () => {
  it("advances once per seven days", () => {
    const d = new Date(2026, 6, 22);
    const week = localWeekNumber(d);
    const plus7 = new Date(2026, 6, 29);
    expect(localWeekNumber(plus7)).toBe(week + 1);
  });
});

describe("seededIndex", () => {
  it("is deterministic for the same inputs", () => {
    expect(seededIndex(20655, 28)).toBe(seededIndex(20655, 28));
    expect(seededIndex(20655, 28, 3)).toBe(seededIndex(20655, 28, 3));
  });

  it("always stays within range", () => {
    for (let seed = 0; seed < 500; seed += 1) {
      const idx = seededIndex(seed, 28);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(28);
    }
  });

  it("does not walk the list sequentially like the old modulo pick", () => {
    // The old `seed % length` picked adjacent entries on adjacent days.
    // A hashed pick should break that pattern most of the time.
    let sequentialPairs = 0;
    for (let seed = 20000; seed < 20100; seed += 1) {
      const a = seededIndex(seed, 28);
      const b = seededIndex(seed + 1, 28);
      if ((a + 1) % 28 === b) sequentialPairs += 1;
    }
    expect(sequentialPairs).toBeLessThan(20);
  });

  it("visits a healthy spread of the list across consecutive seeds", () => {
    const seen = new Set<number>();
    for (let seed = 20000; seed < 20056; seed += 1) seen.add(seededIndex(seed, 28));
    expect(seen.size).toBeGreaterThan(18);
  });

  it("salt changes the sequence", () => {
    const plain = Array.from({ length: 20 }, (_, i) => seededIndex(i, 28, 0));
    const salted = Array.from({ length: 20 }, (_, i) => seededIndex(i, 28, 7));
    expect(plain).not.toEqual(salted);
  });

  it("degrades safely on empty or invalid lengths", () => {
    expect(seededIndex(5, 0)).toBe(0);
    expect(seededIndex(5, -3)).toBe(0);
    expect(seededIndex(5, Number.NaN)).toBe(0);
  });
});
