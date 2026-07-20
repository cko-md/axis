/**
 * Deterministic randomness for Paper Glider.
 *
 * Same shape as Second Sense's `rng.ts` (`fnv1aHash` + `mulberry32`), copied
 * rather than imported: games stay self-contained so a chunk boundary drawn
 * around one game directory never has to reach into another. Room geometry,
 * furniture placement, and ring counts all derive from this, so the same seed
 * always assembles the same flight — which is what makes the passability
 * oracle tests (see `level.test.ts` and the oracle spec files) meaningful
 * across a fixed seed corpus.
 */

/**
 * FNV-1a: a small, well-known, dependency-free string hash. Turns an
 * arbitrary seed string into a 32-bit integer for the PRNG below. Not
 * cryptographic and must never be used for anything security-relevant.
 */
export function fnv1aHash(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * mulberry32: a small, fast, deterministic PRNG. Given the same 32-bit seed
 * it produces the same infinite sequence of floats in [0, 1) on every
 * platform, forever — which is what lets a generated room be trusted to
 * regenerate identically in a later session.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Build a seeded random stream from an arbitrary string seed. */
export function createSeededRandom(seed: string): () => number {
  return mulberry32(fnv1aHash(seed));
}

/** Uniform float in [min, max). */
export function randomRange(random: () => number, min: number, max: number): number {
  return min + random() * (max - min);
}

/** Uniform integer in [minInclusive, maxExclusive). */
export function randomInt(random: () => number, minInclusive: number, maxExclusive: number): number {
  return minInclusive + Math.floor(random() * (maxExclusive - minInclusive));
}
