import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { captureRouteError } from "@/lib/observability/captureRouteError";

/**
 * GET /api/fund/insights — persisted daily brief / weekly recap (replaces
 * the one-shot, never-saved output of /api/fund/report). Written by
 * /api/cron/finance-daily today; Phase 5's tool-calling Advisor will write
 * richer rows here once it exists.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const kind = request.nextUrl.searchParams.get("kind");
  let query = supabase
    .from("ai_insights")
    .select("*")
    .eq("user_id", user.id)
    .eq("dismissed", false)
    .order("created_at", { ascending: false })
    .limit(10);

  if (kind) query = query.eq("kind", kind);

  const { data, error } = await query;
  if (error) {
    captureRouteError(error, { route: "/api/fund/insights", operation: "list_insights", area: "fund", status: 500 });
    return NextResponse.json({ error: "INSIGHTS_UNAVAILABLE", message: "Could not load finance insights." }, { status: 500 });
  }
  return NextResponse.json({ insights: data ?? [] });
}
