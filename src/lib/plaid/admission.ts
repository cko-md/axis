import { redisRateLimit } from "@/lib/ratelimit";

export type PlaidAdmission = "allowed" | "limited" | "unavailable";

/**
 * Hosted distributed admission for Plaid calls. Both the user and service-wide
 * budgets must be available and allow the request; there is no per-instance
 * fallback because it cannot enforce a fleet-wide provider cost boundary.
 */
export async function admitPlaidRequest(
  userId: string,
  userLimit: number,
  globalLimit: number,
  prefix: string,
): Promise<PlaidAdmission> {
  try {
    const user = await redisRateLimit(userId, userLimit, "1 m", `${prefix}:user`);
    if (!user) return "unavailable";
    if (!user.success) return "limited";
    const global = await redisRateLimit("global", globalLimit, "1 m", `${prefix}:global`);
    if (!global) return "unavailable";
    return global.success ? "allowed" : "limited";
  } catch {
    return "unavailable";
  }
}
