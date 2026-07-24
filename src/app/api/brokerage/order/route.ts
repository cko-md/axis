import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Order routing scaffold for Public.com (or a generic brokerage).
 *
 * Without keys: returns { routed: false, mode: "log" } (200) so the client can
 * record the intended trade to fund_transactions locally without pretending an
 * execution happened. This is the graceful setup-state.
 *
 * With keys: this is where the real Public.com order placement call would go.
 * Trades are never auto-executed without an explicit confirmed request body.
 */
export async function POST(request: NextRequest) {
  void request;
  let supabase: Awaited<ReturnType<typeof createClient>>;
  try {
    supabase = await createClient();
  } catch {
    return NextResponse.json({ error: "AUTH_UNAVAILABLE" }, { status: 503 });
  }
  let authResult: Awaited<ReturnType<typeof supabase.auth.getUser>>;
  try {
    authResult = await supabase.auth.getUser();
  } catch {
    return NextResponse.json({ error: "AUTH_UNAVAILABLE" }, { status: 503 });
  }
  const { data: { user }, error } = authResult;
  if (error) return NextResponse.json({ error: "AUTH_UNAVAILABLE" }, { status: 503 });
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json(
    {
      error: "LEGACY_ORDER_ROUTE_RETIRED",
      message: "This legacy order-capture route is retired. Use the reviewed order-intent workflow.",
    },
    { status: 410, headers: { "cache-control": "private, no-store" } },
  );
}
