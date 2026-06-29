/** Simple in-memory rate limiter — per-instance fallback when Redis is unavailable. */
import { hasOptionalEnv } from "@/lib/env";

const store = new Map<string, { count: number; resetAt: number }>();
type RateLimitWindow = `${number} ${"ms" | "s" | "m" | "h" | "d"}` | `${number}${"ms" | "s" | "m" | "h" | "d"}`;

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

export async function redisRateLimit(
  key: string,
  limit: number,
  window: RateLimitWindow,
  prefix: string,
): Promise<{ success: boolean } | null> {
  if (!hasOptionalEnv("UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN")) {
    return null;
  }

  const [{ Ratelimit }, { Redis }] = await Promise.all([
    import("@upstash/ratelimit"),
    import("@upstash/redis"),
  ]);
  const ratelimit = new Ratelimit({
    redis: Redis.fromEnv(),
    limiter: Ratelimit.slidingWindow(limit, window),
    prefix,
  });

  return ratelimit.limit(key);
}
