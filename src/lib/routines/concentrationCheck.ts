import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/database.types";
import { sumBy } from "@/lib/fund/money";
import {
  breachObjective,
  reviewConcentration,
  type ConcentrationReview,
  type Position,
} from "@/lib/skills/concentrationReview";
import type { RoutineStep } from "@/lib/routines/executor";
import { createAgentTaskWithActivity } from "@/lib/tasks/taskPersistence";

const TERMINAL_TASK = ["completed", "failed", "cancelled"];

export const CONCENTRATION_CHECK_ROUTINE_KEY = "concentration_review";

export type ConcentrationTaskOutcome = {
  created: { id: string; objective: string }[];
  skipped: number;
};

export type ConcentrationCheckOutputs = {
  load_holdings: Position[];
  review_concentration: ConcentrationReview;
  create_tasks: ConcentrationTaskOutcome;
};

export function concentrationCheckSteps(input: {
  supabase: SupabaseClient<Database>;
  userId: string;
  maxWeight: number;
}): RoutineStep<ConcentrationCheckOutputs>[] {
  const { supabase, userId, maxWeight } = input;

  return [
    {
      key: "load_holdings",
      input: () => ({}),
      run: async () => {
        const { data, error } = await supabase
          .from("fund_holdings")
          .select("symbol, cost_basis")
          .eq("user_id", userId);
        if (error) throw new Error("HOLDINGS_UNAVAILABLE");

        const bySymbol = new Map<string, number>();
        for (const row of data ?? []) {
          bySymbol.set(row.symbol, (bySymbol.get(row.symbol) ?? 0) + Number(row.cost_basis));
        }
        return [...bySymbol.entries()].map(([symbol, value]) => ({ symbol, value }));
      },
    },
    {
      key: "review_concentration",
      input: ({ outputs }) => {
        const positions = requirePositions(outputs);
        return { maxWeight, positions: positions.length };
      },
      run: async ({ outputs }) => reviewConcentration(requirePositions(outputs), maxWeight),
    },
    {
      key: "create_tasks",
      input: ({ outputs }) => ({ breaches: requireReview(outputs).breaches.length }),
      run: async ({ runId, outputs, idempotencyKey }) => {
        const review = requireReview(outputs);
        if (review.breaches.length === 0) return { created: [], skipped: 0 };

        const [openTasksResult, routineTasksResult] = await Promise.all([
          supabase
            .from("agent_tasks")
            .select("objective")
            .eq("user_id", userId)
            .not("status", "in", `(${TERMINAL_TASK.join(",")})`),
          supabase
            .from("agent_tasks")
            .select("id, objective, idempotency_key")
            .eq("user_id", userId)
            .eq("source_routine_id", runId),
        ]);
        const { data: openTasks, error: openTasksError } = openTasksResult;
        if (openTasksError) throw new Error("TASKS_UNAVAILABLE");
        if (routineTasksResult.error) throw new Error("TASKS_UNAVAILABLE");
        const open = new Set((openTasks ?? []).map((task) => task.objective));
        const completedSideEffects = new Map(
          (routineTasksResult.data ?? [])
            .filter(
              (task): task is typeof task & { idempotency_key: string } =>
                typeof task.idempotency_key === "string"
                && task.idempotency_key.length > 0,
            )
            .map((task) => [
              task.idempotency_key,
              { id: task.id, objective: task.objective },
            ]),
        );

        const created: { id: string; objective: string }[] = [];
        let skipped = 0;
        for (const breach of review.breaches) {
          const objective = breachObjective(breach, maxWeight);
          const taskIdempotencyKey = routineTaskIdempotencyKey({
            runId,
            stepKey: "create_tasks",
            sideEffectKey: breach.symbol,
            resumeIdempotencyKey: idempotencyKey,
          });
          const completedSideEffect = completedSideEffects.get(taskIdempotencyKey);
          if (completedSideEffect) {
            if (completedSideEffect.objective !== objective) {
              throw new Error("TASK_IDEMPOTENCY_CONFLICT");
            }
            created.push(completedSideEffect);
            continue;
          }
          if (open.has(objective)) {
            skipped += 1;
            continue;
          }

          const context: Json = {
            skill: CONCENTRATION_CHECK_ROUTINE_KEY,
            run_id: runId,
            idempotency_key: taskIdempotencyKey,
            evidence: {
              symbol: breach.symbol,
              weight: breach.weight,
              value: breach.value,
              overByValue: breach.overByValue,
              portfolioTotal: review.total,
              maxWeight,
            },
          };
          const result = await createAgentTaskWithActivity({
            userId,
            objective,
            context,
            sourceRoutineId: runId,
            sourceSkill: CONCENTRATION_CHECK_ROUTINE_KEY,
            idempotencyKey: taskIdempotencyKey,
            activityDetail: {
              by: CONCENTRATION_CHECK_ROUTINE_KEY,
              idempotency_key: taskIdempotencyKey,
            },
          });
          if (!result.ok) throw new Error("TASK_CREATE_FAILED");
          const task = result.task;
          const createdTask = { id: task.id, objective: task.objective };
          created.push(createdTask);
          completedSideEffects.set(taskIdempotencyKey, createdTask);
        }

        return { created, skipped };
      },
    },
  ];
}

export function routineTaskIdempotencyKey(input: {
  runId: string;
  stepKey: string;
  sideEffectKey: string;
  resumeIdempotencyKey: string | null;
}): string {
  const executionKey = input.resumeIdempotencyKey
    ?? `routine:${input.runId}:${input.stepKey}`;
  const digest = createHash("sha256")
    .update(JSON.stringify([
      executionKey,
      input.runId,
      input.stepKey,
      input.sideEffectKey,
      "agent_task",
    ]))
    .digest("hex");
  return `routine-task:v1:${digest}`;
}

export function buildConcentrationCheckOutput(outputs: Partial<ConcentrationCheckOutputs>): Json {
  const positions = requirePositions(outputs);
  const review = requireReview(outputs);
  const outcome = outputs.create_tasks;
  if (!outcome) throw new Error("RUN_REPLAY_INCOMPLETE");

  return {
    total: sumBy(positions, (position) => position.value),
    breaches: review.breaches.length,
    created: outcome.created,
    skipped: outcome.skipped,
  };
}

export function concentrationMaxWeightFromSnapshot(snapshot: Json): number {
  if (
    snapshot &&
    typeof snapshot === "object" &&
    !Array.isArray(snapshot) &&
    typeof snapshot.maxWeight === "number" &&
    snapshot.maxWeight > 0 &&
    snapshot.maxWeight <= 1
  ) {
    return snapshot.maxWeight;
  }
  return 0.25;
}

export function concentrationMaxWeightFromBps(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 10000
    ? value / 10000
    : null;
}

export function normalizeConcentrationMaxWeight(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1
    ? value
    : null;
}

function requirePositions(outputs: Partial<ConcentrationCheckOutputs>): Position[] {
  if (!outputs.load_holdings) throw new Error("RUN_REPLAY_INCOMPLETE");
  return outputs.load_holdings;
}

function requireReview(outputs: Partial<ConcentrationCheckOutputs>): ConcentrationReview {
  if (!outputs.review_concentration) throw new Error("RUN_REPLAY_INCOMPLETE");
  return outputs.review_concentration;
}
