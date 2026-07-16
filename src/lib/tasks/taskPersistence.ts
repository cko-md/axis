import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database, Json } from "@/lib/supabase/database.types";

export type AgentTaskRow = Database["public"]["Tables"]["agent_tasks"]["Row"];

export type AtomicTaskResult =
  | {
      ok: true;
      task: AgentTaskRow;
      outcome: "created" | "existing" | "updated";
      created: boolean;
    }
  | {
      ok: false;
      code: "SERVICE_UNAVAILABLE" | "RPC_FAILED" | "INVALID_RESPONSE" | "NOT_FOUND" | "CONFLICT";
      currentStatus?: string;
    };

type AdminClient = SupabaseClient<Database>;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function taskFrom(value: unknown): AgentTaskRow | null {
  const row = record(value);
  return row
    && typeof row.id === "string"
    && typeof row.objective === "string"
    && typeof row.status === "string"
    ? row as AgentTaskRow
    : null;
}

function parseTaskResult(
  data: unknown,
  successOutcomes: readonly ("created" | "existing" | "updated")[],
): AtomicTaskResult {
  const result = record(data);
  if (!result || typeof result.outcome !== "string") {
    return { ok: false, code: "INVALID_RESPONSE" };
  }
  if (successOutcomes.includes(result.outcome as "created" | "existing" | "updated")) {
    const task = taskFrom(result.task);
    const outcome = result.outcome as "created" | "existing" | "updated";
    return task
      ? { ok: true, task, outcome, created: outcome === "created" }
      : { ok: false, code: "INVALID_RESPONSE" };
  }
  if (result.outcome === "not_found") return { ok: false, code: "NOT_FOUND" };
  if (result.outcome === "conflict") {
    return {
      ok: false,
      code: "CONFLICT",
      ...(typeof result.currentStatus === "string" ? { currentStatus: result.currentStatus } : {}),
    };
  }
  return { ok: false, code: "INVALID_RESPONSE" };
}

export async function createAgentTaskWithActivity(
  input: {
    userId: string;
    objective: string;
    context: Json;
    sourceRoutineId?: string | null;
    sourceSkill?: string | null;
    activityDetail?: Json;
    idempotencyKey?: string | null;
  },
  client: AdminClient | null = createAdminClient(),
): Promise<AtomicTaskResult> {
  if (!client) return { ok: false, code: "SERVICE_UNAVAILABLE" };
  const idempotent = typeof input.idempotencyKey === "string"
    && input.idempotencyKey.trim().length > 0;
  const { data, error } = await client.rpc(
    idempotent
      ? "create_idempotent_agent_task_with_activity"
      : "create_agent_task_with_activity",
    {
      p_user_id: input.userId,
      p_objective: input.objective,
      p_context: input.context,
      p_source_routine_id: input.sourceRoutineId ?? null,
      p_source_skill: input.sourceSkill ?? null,
      p_activity_detail: input.activityDetail ?? {},
      ...(idempotent ? { p_idempotency_key: input.idempotencyKey } : {}),
    },
  );
  if (error) return { ok: false, code: "RPC_FAILED" };
  return parseTaskResult(data, idempotent ? ["created", "existing"] : ["created"]);
}

export async function transitionAgentTask(
  input: {
    userId: string;
    taskId: string;
    expectedStatus: string;
    nextStatus: string;
    completedAt?: string | null;
  },
  client: AdminClient | null = createAdminClient(),
): Promise<AtomicTaskResult> {
  if (!client) return { ok: false, code: "SERVICE_UNAVAILABLE" };
  const { data, error } = await client.rpc("cas_agent_task_transition", {
    p_user_id: input.userId,
    p_task_id: input.taskId,
    p_expected_status: input.expectedStatus,
    p_next_status: input.nextStatus,
    p_completed_at: input.completedAt ?? null,
  });
  if (error) return { ok: false, code: "RPC_FAILED" };
  return parseTaskResult(data, ["updated"]);
}
