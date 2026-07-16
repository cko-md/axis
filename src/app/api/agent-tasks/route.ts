import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/database.types";
import { TASK_STATUSES, type FinancialTaskStatus } from "@/lib/tasks/taskState";
import {
  AgentTaskCreateError,
  createAgentTask,
} from "@/lib/tasks/taskPersistence";
import { captureRouteError } from "@/lib/observability/captureRouteError";

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
const ROUTE = "agent-tasks.collection";
const CREATE_FIELDS = new Set(["objective", "context", "estimated_cost_usd"]);

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

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => !CREATE_FIELDS.has(key))
  ) {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  const objective = typeof body.objective === "string" ? body.objective.trim() : "";
  if (!objective || objective.length > MAX_OBJECTIVE) {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  if (
    body.context !== undefined &&
    (!body.context || typeof body.context !== "object" || Array.isArray(body.context))
  ) {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  const context: Json = body.context === undefined ? {} : body.context as Json;
  const rawEstimatedCost = body.estimated_cost_usd;
  const estimatedCostUsd = rawEstimatedCost == null
    ? null
    : typeof rawEstimatedCost === "number" &&
        Number.isFinite(rawEstimatedCost) &&
        rawEstimatedCost >= 0
      ? rawEstimatedCost
      : undefined;
  if (estimatedCostUsd === undefined) {
    return NextResponse.json({ error: "INVALID_ESTIMATED_COST" }, { status: 400 });
  }
  const admin = createAdminClient();
  if (!admin) {
    return NextResponse.json(
      {
        error: "TASK_SERVICE_NOT_CONFIGURED",
        message: "Task creation is temporarily unavailable.",
      },
      { status: 503 },
    );
  }

  try {
    const created = await createAgentTask(admin, {
      userId: user.id,
      objective,
      context,
      sourceRoutineId: null,
      sourceSkill: null,
      estimatedCostUsd,
    });
    return NextResponse.json({ task: created.task }, { status: 201 });
  } catch (error) {
    captureRouteError(
      error instanceof AgentTaskCreateError ? error.cause : error,
      {
        route: ROUTE,
        operation: "create",
        area: "tasks",
        status: 500,
        code: "TASK_CREATE_FAILED",
      },
    );
    return NextResponse.json({ error: "TASK_CREATE_FAILED" }, { status: 500 });
  }
}
