import { NextResponse } from "next/server";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { createClient } from "@/lib/supabase/server";
import { memoryRateLimit } from "@/lib/ratelimit";
import { scanPlatformForUser } from "@/lib/signals/scan";

export async function POST() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Rate limit: 30 requests per minute per user (Redis when available, memory fallback)
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    const ratelimit = new Ratelimit({
      redis: Redis.fromEnv(),
      limiter: Ratelimit.slidingWindow(30, "1 m"),
      prefix: "axis:signals-scan",
    });
    const { success } = await ratelimit.limit(user.id);
    if (!success) {
      return NextResponse.json({ error: "Rate limit exceeded. Try again in a minute." }, { status: 429 });
    }
  } else {
    const { success } = memoryRateLimit(`signals-scan:${user.id}`, 30, 60_000);
    if (!success) {
      return NextResponse.json({ error: "Rate limit exceeded. Try again in a minute." }, { status: 429 });
    }
  }

  const result = await scanPlatformForUser(user.id, supabase);
  return NextResponse.json(result);
}
