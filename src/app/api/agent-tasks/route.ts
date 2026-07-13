import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { Json } from "@/lib/supabase/database.types";
import { TASK_STATUSES, type FinancialTaskStatus } from "@/lib/tasks/taskState";

/**
 * Durable agent-Task collection API — the persistence wiring for the pure state
 * machine in src/lib/tasks/taskState.ts (backed by public.agent_tasks). Every
 * handler authenticates the user and relies on owner-scoped RLS; the status
 * lifecycle itself is guarded by taskState in the per-id PATCH handler.
 *
 * GET  → the user's agent-Tasks, newest activity first (optional ?status=).
 * POST → create a new task in the initial `queued` state + seed its activity log.
 */

const MAX_OBJECTIVE = 2000;

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const statusParam = request.nextUrl.searchParams.get("status");
  if (statusParam && !TASK_STATUSES.includes(statusParam as FinancialTaskStatus)) {
    return NextResponse.json({ error: "INVALID_STATUS" }, { status: 400 });
  }

  let query = supabase
    .from("agent_tasks")
    .select("id, objective, status, context, source_routine_id, source_skill, estimated_cost_usd, actual_cost_usd, created_at, updated_at, completed_at")
    .eq("user_id", user.id)
    .order("updated_at", { ascending: false });
  if (statusParam) query = query.eq("status", statusParam);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: "TASKS_UNAVAILABLE" }, { status: 500 });
  return NextResponse.json({ tasks: data ?? [] });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const objective = String(body.objective ?? "").trim();
  if (!objective || objective.length > MAX_OBJECTIVE) {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  const context: Json =
    body.context && typeof body.context === "object" && !Array.isArray(body.context)
      ? (body.context as Json)
      : {};
  const sourceSkill = body.source_skill == null ? null : String(body.source_skill);
  const sourceRoutineId = body.source_routine_id == null ? null : String(body.source_routine_id);

  const { data: task, error } = await supabase
    .from("agent_tasks")
    .insert({
      user_id: user.id,
      objective,
      status: "queued",
      context,
      source_skill: sourceSkill,
      source_routine_id: sourceRoutineId,
    })
    .select("id, objective, status, context, source_routine_id, source_skill, created_at, updated_at, completed_at")
    .single();

  if (error || !task) return NextResponse.json({ error: "TASK_CREATE_FAILED" }, { status: 500 });

  // Seed the append-only activity log with the initial state (best-effort; the
  // task already exists, so a log failure must not fail the request).
  await supabase.from("agent_task_activity").insert({
    task_id: task.id,
    user_id: user.id,
    kind: "status_change",
    detail: { from: null, to: "queued" },
  });

  return NextResponse.json({ task }, { status: 201 });
}
