import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { memoryRateLimit, redisRateLimit } from "@/lib/ratelimit";
import { scanPlatformForUser } from "@/lib/signals/scan";

export async function POST() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Rate limit: 30 requests per minute per user (Redis when available, memory fallback)
  const { success } =
    (await redisRateLimit(user.id, 30, "1 m", "axis:signals-scan")) ??
    memoryRateLimit(`signals-scan:${user.id}`, 30, 60_000);
  if (!success) {
    return NextResponse.json({ error: "Rate limit exceeded. Try again in a minute." }, { status: 429 });
  }

  const result = await scanPlatformForUser(user.id, supabase);
  return NextResponse.json(result);
}
