import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import type { Json } from "@/lib/supabase/database.types";
import { TASK_STATUSES, type FinancialTaskStatus } from "@/lib/tasks/taskState";
import { createAgentTaskWithActivity } from "@/lib/tasks/taskPersistence";
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
const taskCreateSchema = z.object({
  objective: z.string().trim().min(1).max(MAX_OBJECTIVE),
  context: z.record(z.string(), z.unknown()).optional(),
}).strict();

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

  const parsed = taskCreateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  const objective = parsed.data.objective;
  const context = (parsed.data.context ?? {}) as Json;

  const result = await createAgentTaskWithActivity({
    userId: user.id,
    objective,
    context,
  });
  if (!result.ok) {
    const status = result.code === "SERVICE_UNAVAILABLE" ? 503 : 500;
    const code = result.code === "SERVICE_UNAVAILABLE"
      ? "TASK_MUTATION_UNAVAILABLE"
      : "TASK_CREATE_FAILED";
    captureRouteError(new Error(code), {
      route: "agent_tasks",
      operation: "create",
      area: "tasks",
      status,
      code,
    });
    return NextResponse.json({ error: code }, { status });
  }

  return NextResponse.json({ task: result.task }, { status: 201 });
}
