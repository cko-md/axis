import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  canTransition,
  isTerminal,
  TASK_STATUSES,
  type FinancialTaskStatus,
} from "@/lib/tasks/taskState";
import { transitionAgentTask } from "@/lib/tasks/taskPersistence";
import { captureRouteError } from "@/lib/observability/captureRouteError";

/**
 * Single agent-Task API — read and lifecycle transition.
 *
 * PATCH enforces the pure state machine (src/lib/tasks/taskState.ts) SERVER-SIDE:
 * an illegal status change (e.g. reviving a completed task, or jumping to
 * `executing` without passing through approval) is rejected with 409 rather than
 * corrupting task history. RLS scopes every row to the owner; we additionally
 * read the current status to evaluate the transition.
 */

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: task, error } = await supabase
    .from("agent_tasks")
    .select("id, objective, status, context, source_routine_id, source_skill, estimated_cost_usd, actual_cost_usd, created_at, updated_at, completed_at")
    .eq("user_id", user.id)
    .eq("id", id)
    .maybeSingle();

  if (error) return NextResponse.json({ error: "TASK_UNAVAILABLE" }, { status: 500 });
  if (!task) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  const { data: activity, error: activityError } = await supabase
    .from("agent_task_activity")
    .select("id, kind, detail, created_at")
    .eq("user_id", user.id)
    .eq("task_id", id)
    .order("created_at", { ascending: true });
  if (activityError) {
    captureRouteError(new Error("Task activity query failed"), {
      route: "agent_tasks",
      operation: "detail_activity",
      area: "tasks",
      status: 500,
      code: "TASK_ACTIVITY_UNAVAILABLE",
    });
    return NextResponse.json({ error: "TASK_ACTIVITY_UNAVAILABLE" }, { status: 500 });
  }

  return NextResponse.json({ task, activity: activity ?? [] });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const nextStatus = body.status;
  if (typeof nextStatus !== "string" || !TASK_STATUSES.includes(nextStatus as FinancialTaskStatus)) {
    return NextResponse.json({ error: "INVALID_STATUS" }, { status: 400 });
  }

  // Read current status to evaluate the transition (RLS scopes to owner).
  const { data: current, error: readError } = await supabase
    .from("agent_tasks")
    .select("status")
    .eq("user_id", user.id)
    .eq("id", id)
    .maybeSingle();
  if (readError) return NextResponse.json({ error: "TASK_UNAVAILABLE" }, { status: 500 });
  if (!current) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  const from = current.status as FinancialTaskStatus;
  const to = nextStatus as FinancialTaskStatus;

  if (from === to) return NextResponse.json({ error: "NO_CHANGE" }, { status: 409 });
  if (!canTransition(from, to)) {
    // Expected, user-recoverable conflict — not a Sentry-worthy exception.
    return NextResponse.json(
      { error: "ILLEGAL_TRANSITION", from, to },
      { status: 409 },
    );
  }

  const result = await transitionAgentTask({
    userId: user.id,
    taskId: id,
    expectedStatus: from,
    nextStatus: to,
    completedAt: isTerminal(to) ? new Date().toISOString() : null,
  });
  if (!result.ok) {
    if (result.code === "NOT_FOUND") {
      return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    }
    if (result.code === "CONFLICT") {
      return NextResponse.json(
        { error: "STALE_TRANSITION", from, to, currentStatus: result.currentStatus },
        { status: 409 },
      );
    }
    const status = result.code === "SERVICE_UNAVAILABLE" ? 503 : 500;
    const code = result.code === "SERVICE_UNAVAILABLE"
      ? "TASK_MUTATION_UNAVAILABLE"
      : "TASK_UPDATE_FAILED";
    captureRouteError(new Error(code), {
      route: "agent_tasks",
      operation: "transition",
      area: "tasks",
      status,
      code,
    });
    return NextResponse.json({ error: code }, { status });
  }

  return NextResponse.json({ task: result.task });
}
