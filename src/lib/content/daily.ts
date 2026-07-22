/**
 * Shared daily-rotation helpers for the Command page's content cards
 * (devotional, reflection, art, poem) and the hero line.
 *
 * Two properties matter and both were previously violated in-place:
 *
 * 1. LOCAL day boundary. The old idiom `Math.floor(Date.now() / 86400000)`
 *    rolls over at UTC midnight, so content changed mid-evening in the
 *    Americas and mid-morning in Asia. `localDayNumber` shifts the epoch by
 *    the timezone offset so rotation happens at the user's own midnight.
 *
 * 2. Non-sequential picks. Indexing `day % length` walks a list in author
 *    order, so adjacent days always serve adjacent entries. `seededIndex`
 *    hashes the seed first, which visits the whole list in a scattered but
 *    fully deterministic order.
 */

/** Whole days since epoch in the *local* timezone — rolls at local midnight. */
export function localDayNumber(now: Date = new Date()): number {
  return Math.floor((now.getTime() - now.getTimezoneOffset() * 60_000) / 86_400_000);
}

/** Whole weeks since epoch in the local timezone — rolls weekly. */
export function localWeekNumber(now: Date = new Date()): number {
  return Math.floor(localDayNumber(now) / 7);
}

/**
 * Deterministic scattered pick: same (seed, length, salt) always yields the
 * same index; consecutive seeds jump around the list instead of walking it.
 * The finalizer is the mulberry32 mix — cheap, well distributed, and stable
 * across platforms (pure 32-bit integer math).
 */
export function seededIndex(seed: number, length: number, salt = 0): number {
  if (!Number.isFinite(length) || length <= 0) return 0;
  let h = (Math.trunc(seed) + Math.imul(salt, 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), h | 1);
  h ^= h + Math.imul(h ^ (h >>> 7), h | 61);
  h = (h ^ (h >>> 14)) >>> 0;
  return h % Math.trunc(length);
}
