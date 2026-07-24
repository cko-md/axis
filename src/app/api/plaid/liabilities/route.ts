import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { captureRouteError } from "@/lib/observability/captureRouteError";

/**
 * Normalized liabilities (credit/student/mortgage) via the §10 Plaid adapter —
 * domain Liability records with provenance + freshness, joined to their account
 * balances. Read-only; the access token stays server-side.
 */
export async function GET() {
  let supabase: Awaited<ReturnType<typeof createClient>>;
  try { supabase = await createClient(); } catch {
    return NextResponse.json({ error: "AUTH_UNAVAILABLE" }, { status: 503 });
  }
  let authResult: Awaited<ReturnType<typeof supabase.auth.getUser>>;
  try { authResult = await supabase.auth.getUser(); } catch {
    return NextResponse.json({ error: "AUTH_UNAVAILABLE" }, { status: 503 });
  }
  const { data: { user }, error: authError } = authResult;
  if (authError) {
    captureRouteError(new Error("Plaid liabilities authentication unavailable"), {
      route: "/api/plaid/liabilities", operation: "authenticate", area: "fund",
      provider: "supabase", status: 503, code: "AUTH_BACKEND_UNAVAILABLE",
    });
    return NextResponse.json({ error: "AUTH_UNAVAILABLE" }, { status: 503 });
  }
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  return NextResponse.json(
    {
      error: "LIVE_PLAID_LIABILITY_ROUTE_RETIRED",
      message: "Use /api/fund/liabilities for cached provider-authoritative liabilities.",
    },
    { status: 410, headers: { "cache-control": "private, no-store" } },
  );
}
