import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { Json } from "@/lib/supabase/database.types";
import { sumBy } from "@/lib/fund/money";
import { breachObjective, reviewConcentration, type Position } from "@/lib/skills/concentrationReview";
import { deriveRunOutcome, isRunTerminal, type StepStatus } from "@/lib/routines/runState";
import { planResume, type ExistingStep } from "@/lib/routines/runner";
import { emitServerEvent } from "@/lib/observability/events";

/**
 * Concentration-check routine (program §15.3) — a deterministic trigger that
 * turns a real portfolio into agent-Tasks and records a DURABLE, auditable run
 * (§15.5): a routine_runs row plus a routine_step_runs row per step, each with
 * input/output snapshots. No model, no fabricated data; it never trades.
 *
 * Idempotent in two ways: a breach whose objective already has a non-terminal
 * task is skipped; and a run can be RESUMED (POST { runId }) — succeeded steps
 * are not recomputed, their recorded outputs are reused, and only the remaining
 * steps run. A step failure marks the run `blocked` (non-terminal) so it can be
 * resumed rather than lost.
 */

const TERMINAL_TASK = ["completed", "failed", "cancelled"];
const ROUTINE_KEY = "concentration_review";
const ORDERED_KEYS = ["load_holdings", "review_concentration", "create_tasks"] as const;

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as { maxWeight?: number; runId?: string };

  // ── Resume an existing run, or open a new one ──────────────────────────────
  let runId: string;
  let maxWeight: number;
  let reuse: Record<string, unknown> = {};

  if (typeof body.runId === "string" && body.runId) {
    const { data: existingRun } = await supabase
      .from("routine_runs")
      .select("id, status, input_snapshot")
      .eq("user_id", user.id)
      .eq("id", body.runId)
      .eq("routine_key", ROUTINE_KEY)
      .maybeSingle();
    if (!existingRun) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    if (isRunTerminal(existingRun.status as never)) {
      return NextResponse.json({ error: "CANNOT_RESUME", status: existingRun.status }, { status: 409 });
    }
    runId = existingRun.id;
    maxWeight = readMaxWeight((existingRun.input_snapshot as { maxWeight?: number } | null)?.maxWeight);
    const { data: steps } = await supabase
      .from("routine_step_runs")
      .select("step_key, status, output_snapshot")
      .eq("user_id", user.id)
      .eq("run_id", runId);
    reuse = planResume(ORDERED_KEYS, (steps ?? []) as ExistingStep[]).reuse;
    await supabase.from("routine_runs").update({ status: "running" }).eq("id", runId);
  } else {
    maxWeight = readMaxWeight(body.maxWeight);
    const { data: run, error: runError } = await supabase
      .from("routine_runs")
      .insert({ user_id: user.id, routine_key: ROUTINE_KEY, status: "running", trigger: "manual", input_snapshot: { maxWeight }, estimated_cost_usd: 0 })
      .select("id")
      .single();
    if (runError || !run) return NextResponse.json({ error: "RUN_START_FAILED" }, { status: 500 });
    runId = run.id;
  }

  const stepStatuses: StepStatus[] = [];

  /**
   * Run one durable step — unless its output was already recorded (reuse), in
   * which case it is skipped and the recorded output is returned (idempotent
   * resume). Records running -> succeeded/failed with snapshots otherwise.
   */
  async function step<T>(stepKey: (typeof ORDERED_KEYS)[number], input: Json, fn: () => Promise<T>): Promise<T> {
    if (stepKey in reuse) {
      stepStatuses.push("succeeded");
      return reuse[stepKey] as T;
    }
    const ordinal = ORDERED_KEYS.indexOf(stepKey) + 1;
    const { data: stepRow } = await supabase
      .from("routine_step_runs")
      .insert({ run_id: runId, user_id: user!.id, step_key: stepKey, ordinal, status: "running", input_snapshot: input, started_at: new Date().toISOString() })
      .select("id")
      .single();
    try {
      const result = await fn();
      await supabase
        .from("routine_step_runs")
        .update({ status: "succeeded", output_snapshot: (result ?? null) as Json, completed_at: new Date().toISOString() })
        .eq("id", stepRow?.id ?? "");
      stepStatuses.push("succeeded");
      return result;
    } catch (err) {
      await supabase
        .from("routine_step_runs")
        .update({ status: "failed", error: err instanceof Error ? err.message : "step failed", completed_at: new Date().toISOString() })
        .eq("id", stepRow?.id ?? "");
      stepStatuses.push("failed");
      throw err;
    }
  }

  try {
    const positions = await step("load_holdings", {}, async () => {
      const { data, error } = await supabase
        .from("fund_holdings")
        .select("symbol, cost_basis")
        .eq("user_id", user.id);
      if (error) throw new Error("HOLDINGS_UNAVAILABLE");
      const bySymbol = new Map<string, number>();
      for (const row of data ?? []) bySymbol.set(row.symbol, (bySymbol.get(row.symbol) ?? 0) + Number(row.cost_basis));
      return [...bySymbol.entries()].map(([symbol, value]) => ({ symbol, value })) as Position[];
    });

    const review = await step("review_concentration", { maxWeight, positions: positions.length }, async () =>
      reviewConcentration(positions, maxWeight),
    );

    const outcome = await step("create_tasks", { breaches: review.breaches.length }, async () => {
      if (review.breaches.length === 0) return { created: [] as { id: string; objective: string }[], skipped: 0 };
      const { data: openTasks } = await supabase
        .from("agent_tasks")
        .select("objective")
        .eq("user_id", user.id)
        .not("status", "in", `(${TERMINAL_TASK.join(",")})`);
      const open = new Set((openTasks ?? []).map((t) => t.objective));

      const created: { id: string; objective: string }[] = [];
      let skipped = 0;
      for (const breach of review.breaches) {
        const objective = breachObjective(breach, maxWeight);
        if (open.has(objective)) { skipped += 1; continue; }
        const context: Json = {
          skill: ROUTINE_KEY,
          run_id: runId,
          evidence: { symbol: breach.symbol, weight: breach.weight, value: breach.value, overByValue: breach.overByValue, portfolioTotal: review.total, maxWeight },
        };
        const { data: task } = await supabase
          .from("agent_tasks")
          .insert({ user_id: user.id, objective, status: "queued", context, source_skill: ROUTINE_KEY })
          .select("id, objective")
          .single();
        if (!task) continue;
        await supabase.from("agent_task_activity").insert({ task_id: task.id, user_id: user.id, kind: "status_change", detail: { from: null, to: "queued", by: ROUTINE_KEY } });
        created.push({ id: task.id, objective: task.objective });
      }
      return { created, skipped };
    });

    const output = { total: sumBy(positions, (p) => p.value), breaches: review.breaches.length, created: outcome.created, skipped: outcome.skipped };
    const status = deriveRunOutcome(stepStatuses);
    await supabase
      .from("routine_runs")
      .update({ status, output: output as Json, actual_cost_usd: 0, completed_at: new Date().toISOString() })
      .eq("id", runId);

    emitServerEvent("routine.run.completed", {
      routine: ROUTINE_KEY,
      runId,
      status,
      breaches: review.breaches.length,
      tasksCreated: outcome.created.length,
      tasksSkipped: outcome.skipped,
    });

    return NextResponse.json({ runId, status, ...output });
  } catch (err) {
    // A step threw — mark the run `blocked` (non-terminal) so it can be RESUMED,
    // leaving the recorded step snapshots intact for inspection.
    await supabase
      .from("routine_runs")
      .update({ status: "blocked", error: err instanceof Error ? err.message : "run failed" })
      .eq("id", runId);
    emitServerEvent("routine.run.blocked", {
      routine: ROUTINE_KEY,
      runId,
      error: err instanceof Error ? err.message : "run failed",
    });
    return NextResponse.json({ error: "RUN_BLOCKED", runId, resumable: true }, { status: 500 });
  }
}

function readMaxWeight(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0.25;
}
