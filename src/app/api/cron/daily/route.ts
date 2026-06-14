import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Vercel cron: runs daily at 06:00 UTC (configured in vercel.json)
// Requires CRON_SECRET env var — Vercel sets the Authorization header automatically
// when invoking crons; set the same secret in your project env vars.
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Use SECURITY DEFINER RPCs (migration 011) so cleanup runs across all users
  // regardless of RLS. Raw table queries via the anon client would be filtered
  // to auth.uid() = null and affect zero rows.
  const supabase = await createClient();
  const results: Record<string, unknown> = {};

  // 1. Mark overdue tasks via SECURITY DEFINER function
  const { data: overdueCount, error: tasksError } = await supabase.rpc("mark_overdue_tasks");
  results.overdue_tasks = tasksError
    ? { error: tasksError.message }
    : { updated: overdueCount ?? 0 };

  // 2. Delete old routed signals via SECURITY DEFINER function
  const { data: deletedCount, error: signalsError } = await supabase.rpc("cleanup_old_signals");
  results.old_signals_deleted = signalsError
    ? { error: signalsError.message }
    : { deleted: deletedCount ?? 0 };

  return NextResponse.json({ ok: true, message: "Maintenance complete", results });
}
