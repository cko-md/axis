import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/** Retired unsafe order-capture boundary. Use prepare-only /api/brokerage/orders. */
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
