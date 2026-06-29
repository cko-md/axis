/** Simple in-memory rate limiter — per-instance fallback when Redis is unavailable. */
const store = new Map<string, { count: number; resetAt: number }>();

export function memoryRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): { success: boolean } {
  const now = Date.now();
  const entry = store.get(key);
  if (!entry || now >= entry.resetAt) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return { success: true };
  }
  entry.count++;
  if (entry.count > limit) return { success: false };
  return { success: true };
}
