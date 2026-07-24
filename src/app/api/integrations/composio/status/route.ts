import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  listComposioConnectionProjections,
  refreshComposioConnectionAuthority,
} from "@/lib/integrations/composio-identity";
import { captureRouteError } from "@/lib/observability/captureRouteError";
import { redisRateLimit } from "@/lib/ratelimit";

const STATUS_REFRESH_LIMIT = 8;
const STATUS_REFRESH_CONCURRENCY = 3;
const STATUS_REFRESH_DEADLINE_MS = 15_000;

async function refreshBounded(userId: string, connections: Awaited<ReturnType<typeof listComposioConnectionProjections>>) {
  const output = new Array(connections.length);
  let cursor = 0;
  const deadlineAt = Date.now() + STATUS_REFRESH_DEADLINE_MS;
  await Promise.all(Array.from({ length: Math.min(STATUS_REFRESH_CONCURRENCY, connections.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= connections.length) return;
      const connection = connections[index];
      if (Date.now() >= deadlineAt) {
        output[index] = { ...connection, status: "UNVERIFIED", remoteVerifiedAt: null };
        continue;
      }
      output[index] = await refreshComposioConnectionAuthority({ userId, connectionId: connection.id })
        ?? { ...connection, status: "UNVERIFIED", remoteVerifiedAt: null };
    }
  }));
  return output;
}

// GET /api/integrations/composio/status
// Polls each opaque local connection id independently. A stale ACTIVE row or a
// different connection for the same toolkit cannot satisfy an OAuth attempt.
export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError) {
    return NextResponse.json({ error: "Authentication is temporarily unavailable." }, { status: 503 });
  }
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  const rawCursor = req.nextUrl.searchParams.get("cursor");
  const offset = rawCursor === null ? 0 : Number(rawCursor);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10_000) {
    return NextResponse.json({ error: "Invalid status cursor" }, { status: 400 });
  }
  let admission;
  try {
    admission = await redisRateLimit(user.id, 30, "1 m", "axis-composio-status");
  } catch {
    return NextResponse.json({ error: "Provider status admission is unavailable." }, { status: 503 });
  }
  if (!admission) return NextResponse.json({ error: "Provider status admission is unavailable." }, { status: 503 });
  if (!admission.success) return NextResponse.json({ error: "Provider status rate limit exceeded." }, { status: 429 });

  try {
    const projections = await listComposioConnectionProjections(user.id, {
      limit: STATUS_REFRESH_LIMIT + 1,
      offset,
    });
    // Bound refresh avoids letting a corrupted/legacy account set create an
    // unbounded provider fan-out during a normal status poll.
    const visible = projections.slice(0, STATUS_REFRESH_LIMIT);
    const connections = await refreshBounded(user.id, visible);
    const hasMore = projections.length > STATUS_REFRESH_LIMIT;
    return NextResponse.json({
      connections,
      truncated: hasMore,
      nextCursor: hasMore ? String(offset + STATUS_REFRESH_LIMIT) : null,
    });
  } catch (error) {
    captureRouteError(error, {
      route: "/api/integrations/composio/status",
      operation: "refresh_connection_authority",
      area: "integrations",
      provider: "composio",
      status: 503,
    });
    return NextResponse.json({ connections: [], error: "Connection status is unavailable." }, { status: 503 });
  }
}
