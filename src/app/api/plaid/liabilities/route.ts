import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resolveRouteIdentity } from "@/lib/auth/routeIdentity";

/**
 * Normalized liabilities (credit/student/mortgage) via the §10 Plaid adapter —
 * domain Liability records with provenance + freshness, joined to their account
 * balances. Read-only; the access token stays server-side.
 */
export async function GET() {
  const identity = await resolveRouteIdentity(createClient, { route: "/api/plaid/liabilities", area: "fund" });
  if (!identity.ok) return NextResponse.json(
    { error: identity.status === 401 ? "Unauthorized" : identity.code },
    { status: identity.status },
  );

  return NextResponse.json(
    {
      error: "LIVE_PLAID_LIABILITY_ROUTE_RETIRED",
      message: "Use /api/fund/liabilities for cached provider-authoritative liabilities.",
    },
    { status: 410, headers: { "cache-control": "private, no-store" } },
  );
}
