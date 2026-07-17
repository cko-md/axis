import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Routine run history (§15.5) — the durable, auditable record of routine
 * executions. GET returns the user's recent runs; ?runId= returns one run with
 * its ordered step snapshots. Auth + owner-scoped RLS.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const runId = request.nextUrl.searchParams.get("runId");

  if (runId) {
    const { data: run, error } = await supabase
      .from("routine_runs")
      .select("id, routine_key, routine_version, status, trigger, input_snapshot, output, error, actual_cost_usd, paused_step_key, approval_id, idempotency_key, started_at, completed_at")
      .eq("user_id", user.id)
      .eq("id", runId)
      .maybeSingle();
    if (error) return NextResponse.json({ error: "RUN_UNAVAILABLE" }, { status: 500 });
    if (!run) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    const { data: steps } = await supabase
      .from("routine_step_runs")
      .select("id, step_key, ordinal, status, input_snapshot, output_snapshot, error, started_at, completed_at")
      .eq("user_id", user.id)
      .eq("run_id", runId)
      .order("ordinal", { ascending: true });
    return NextResponse.json({ run, steps: steps ?? [] });
  }

  const { data, error } = await supabase
    .from("routine_runs")
    .select("id, routine_key, status, trigger, output, actual_cost_usd, paused_step_key, approval_id, idempotency_key, started_at, completed_at")
    .eq("user_id", user.id)
    .order("started_at", { ascending: false })
    .limit(20);
  if (error) return NextResponse.json({ error: "RUNS_UNAVAILABLE" }, { status: 500 });
  return NextResponse.json({ runs: data ?? [] });
}
