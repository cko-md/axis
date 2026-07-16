import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/database.types";

export type CreatedAgentTask = {
  id: string;
  objective: string;
  status: string;
  context: Json;
  source_routine_id: string | null;
  source_skill: string | null;
  estimated_cost_usd: number | null;
  actual_cost_usd: number | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export type InitialAgentTaskActivity = {
  id: string;
  kind: string;
  detail: Json;
  created_at: string;
};

export type CreatedAgentTaskPayload = {
  task: CreatedAgentTask;
  activity: InitialAgentTaskActivity;
};

export type CreateAgentTaskInput = {
  userId: string;
  objective: string;
  context: Json;
  sourceRoutineId: string | null;
  sourceSkill: string | null;
  sourceClaimToken?: string | null;
  estimatedCostUsd: number | null;
};

export class AgentTaskCreateError extends Error {
  constructor(readonly cause: unknown) {
    super("TASK_CREATE_FAILED");
    this.name = "AgentTaskCreateError";
  }
}

export async function createAgentTask(
  admin: SupabaseClient<Database>,
  input: CreateAgentTaskInput,
): Promise<CreatedAgentTaskPayload> {
  const { data, error } = await admin.rpc("create_agent_task", {
    p_context: input.context,
    p_estimated_cost_usd: input.estimatedCostUsd,
    p_objective: input.objective,
    p_source_routine_id: input.sourceRoutineId,
    p_source_skill: input.sourceSkill,
    p_source_claim_token: input.sourceClaimToken ?? null,
    p_user_id: input.userId,
  });
  if (error) throw new AgentTaskCreateError(error);

  const parsed = parseCreatedAgentTaskPayload(data);
  if (!parsed) throw new AgentTaskCreateError(new Error("TASK_CREATE_RESULT_INVALID"));
  return parsed;
}

export function parseCreatedAgentTaskPayload(value: Json): CreatedAgentTaskPayload | null {
  if (!isRecord(value) || !isRecord(value.task) || !isRecord(value.activity)) return null;
  const task = value.task;
  const activity = value.activity;
  if (
    typeof task.id !== "string" ||
    typeof task.objective !== "string" ||
    typeof task.status !== "string" ||
    !isJson(task.context) ||
    !isNullableString(task.source_routine_id) ||
    !isNullableString(task.source_skill) ||
    !isNullableNumber(task.estimated_cost_usd) ||
    !isNullableNumber(task.actual_cost_usd) ||
    typeof task.created_at !== "string" ||
    typeof task.updated_at !== "string" ||
    !isNullableString(task.completed_at) ||
    typeof activity.id !== "string" ||
    typeof activity.kind !== "string" ||
    !isJson(activity.detail) ||
    typeof activity.created_at !== "string"
  ) {
    return null;
  }

  return {
    task: {
      id: task.id,
      objective: task.objective,
      status: task.status,
      context: task.context,
      source_routine_id: task.source_routine_id,
      source_skill: task.source_skill,
      estimated_cost_usd: task.estimated_cost_usd,
      actual_cost_usd: task.actual_cost_usd,
      created_at: task.created_at,
      updated_at: task.updated_at,
      completed_at: task.completed_at,
    },
    activity: {
      id: activity.id,
      kind: activity.kind,
      detail: activity.detail,
      created_at: activity.created_at,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isJson(value: unknown): value is Json {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJson);
  return isRecord(value) && Object.values(value).every(isJson);
}
