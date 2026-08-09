import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resolveRouteIdentity } from "@/lib/auth/routeIdentity";

/** Retired unsafe order-capture boundary. Use prepare-only /api/brokerage/orders. */
export async function POST(request: NextRequest) {
  void request;
  const identity = await resolveRouteIdentity(createClient, {
    route: "/api/brokerage/order",
    area: "fund",
  });
  if (!identity.ok) {
    return NextResponse.json(
      { error: identity.status === 401 ? "Unauthorized" : identity.code },
      { status: identity.status },
    );
  }
  return NextResponse.json(
    {
      error: "LEGACY_ORDER_ROUTE_RETIRED",
      message: "This legacy order-capture route is retired. Use the reviewed order-intent workflow.",
    },
    { status: 410, headers: { "cache-control": "private, no-store" } },
  );
}
