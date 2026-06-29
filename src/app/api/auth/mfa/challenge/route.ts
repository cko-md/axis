import { NextRequest, NextResponse } from "next/server";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { createClient } from "@/lib/supabase/server";
import { memoryRateLimit } from "@/lib/ratelimit";

// ── POST /api/auth/mfa/challenge ───────────────────────────────────────────────
// Creates an MFA challenge for the given factor. The returned challengeId must
// be passed to /api/auth/mfa/verify along with the one-time code.
//
// Body: { factorId: string }
// Response: { challengeId: string }
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  // Throttle challenge creation too — otherwise an attacker could mint
  // unlimited fresh challenges to widen the brute-force window on /verify.
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    const challengeRatelimit = new Ratelimit({
      redis: Redis.fromEnv(),
      limiter: Ratelimit.slidingWindow(10, "5 m"),
      prefix: "axis:mfa-challenge",
    });
    const { success } = await challengeRatelimit.limit(user.id);
    if (!success) {
      return NextResponse.json({ error: "Too many attempts. Please wait before trying again." }, { status: 429 });
    }
  } else {
    const { success } = memoryRateLimit(`mfa-challenge:${user.id}`, 10, 5 * 60_000);
    if (!success) {
      return NextResponse.json({ error: "Too many attempts. Please wait before trying again." }, { status: 429 });
    }
  }

  let body: { factorId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.factorId || typeof body.factorId !== "string") {
    return NextResponse.json({ error: "factorId is required" }, { status: 400 });
  }

  const { data, error } = await supabase.auth.mfa.challenge({
    factorId: body.factorId,
  });

  if (error || !data) {
    return NextResponse.json(
      { error: error?.message ?? "Failed to create MFA challenge" },
      { status: 400 },
    );
  }

  return NextResponse.json({ challengeId: data.id });
}
