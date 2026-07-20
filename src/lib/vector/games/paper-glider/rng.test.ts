import { describe, expect, it } from "vitest";
import { createSeededRandom, fnv1aHash, mulberry32, randomInt, randomRange } from "@/lib/vector/games/paper-glider/rng";

describe("fnv1aHash", () => {
  it("is deterministic for the same input", () => {
    expect(fnv1aHash("paper-glider")).toBe(fnv1aHash("paper-glider"));
  });

  it("differs for different inputs", () => {
    expect(fnv1aHash("seed-a")).not.toBe(fnv1aHash("seed-b"));
  });

  it("always returns an unsigned 32-bit integer", () => {
    for (const input of ["", "x", "a much longer seed string with spaces and punctuation!"]) {
      const hash = fnv1aHash(input);
      expect(hash).toBeGreaterThanOrEqual(0);
      expect(hash).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

describe("mulberry32", () => {
  it("produces the same sequence for the same seed", () => {
    const a = mulberry32(1234);
    const b = mulberry32(1234);
    const sequenceA = Array.from({ length: 20 }, () => a());
    const sequenceB = Array.from({ length: 20 }, () => b());
    expect(sequenceA).toEqual(sequenceB);
  });

  it("produces different sequences for different seeds", () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    const sequenceA = Array.from({ length: 20 }, () => a());
    const sequenceB = Array.from({ length: 20 }, () => b());
    expect(sequenceA).not.toEqual(sequenceB);
  });

  it("stays within [0, 1)", () => {
    const random = mulberry32(999);
    for (let i = 0; i < 500; i += 1) {
      const value = random();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe("createSeededRandom", () => {
  it("is deterministic end to end from a string seed", () => {
    const a = createSeededRandom("room:7");
    const b = createSeededRandom("room:7");
    expect(Array.from({ length: 10 }, () => a())).toEqual(Array.from({ length: 10 }, () => b()));
  });

  it("gives different rooms different streams even with adjacent seeds", () => {
    const a = createSeededRandom("flight:room:1");
    const b = createSeededRandom("flight:room:2");
    expect(a()).not.toBe(b());
  });
});

describe("randomRange", () => {
  it("stays within [min, max)", () => {
    const random = createSeededRandom("range-check");
    for (let i = 0; i < 500; i += 1) {
      const value = randomRange(random, -5, 5);
      expect(value).toBeGreaterThanOrEqual(-5);
      expect(value).toBeLessThan(5);
    }
  });

  it("collapses to min when min equals max", () => {
    const random = createSeededRandom("degenerate-range");
    expect(randomRange(random, 3, 3)).toBe(3);
  });
});

describe("randomInt", () => {
  it("stays within [minInclusive, maxExclusive) and only returns integers", () => {
    const random = createSeededRandom("int-check");
    for (let i = 0; i < 500; i += 1) {
      const value = randomInt(random, 1, 4);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(1);
      expect(value).toBeLessThan(4);
    }
  });
});
