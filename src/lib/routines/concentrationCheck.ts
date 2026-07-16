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
import { createAgentTask } from "@/lib/tasks/taskPersistence";

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
  taskAdmin: SupabaseClient<Database>;
  userId: string;
  maxWeight: number;
}): RoutineStep<ConcentrationCheckOutputs>[] {
  const { supabase, taskAdmin, userId, maxWeight } = input;

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
      run: async ({ runId, outputs, claimToken, assertClaimActive }) => {
        const review = requireReview(outputs);
        if (review.breaches.length === 0) return { created: [], skipped: 0 };

        const { data: openTasks, error: openTasksError } = await supabase
          .from("agent_tasks")
          .select("objective")
          .eq("user_id", userId)
          .not("status", "in", `(${TERMINAL_TASK.join(",")})`);
        if (openTasksError) throw new Error("TASKS_UNAVAILABLE");
        const open = new Set((openTasks ?? []).map((task) => task.objective));

        const created: { id: string; objective: string }[] = [];
        let skipped = 0;
        for (const breach of review.breaches) {
          const objective = breachObjective(breach, maxWeight);
          if (open.has(objective)) {
            skipped += 1;
            continue;
          }

          const context: Json = {
            skill: CONCENTRATION_CHECK_ROUTINE_KEY,
            run_id: runId,
            evidence: {
              symbol: breach.symbol,
              weight: breach.weight,
              value: breach.value,
              overByValue: breach.overByValue,
              portfolioTotal: review.total,
              maxWeight,
            },
          };
          await assertClaimActive();
          const { task } = await createAgentTask(taskAdmin, {
            userId,
            objective,
            context,
            sourceRoutineId: runId,
            sourceSkill: CONCENTRATION_CHECK_ROUTINE_KEY,
            sourceClaimToken: claimToken,
            estimatedCostUsd: null,
          });
          created.push({ id: task.id, objective: task.objective });
          open.add(objective);
        }

        return { created, skipped };
      },
    },
  ];
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
