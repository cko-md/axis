import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  buildConcentrationCheckOutput,
  concentrationCheckSteps,
  concentrationMaxWeightFromSnapshot,
  CONCENTRATION_CHECK_ROUTINE_KEY,
  type ConcentrationCheckOutputs,
} from "@/lib/routines/concentrationCheck";
import {
  continueRoutineRun,
  createSupabaseRoutineStore,
  executeRoutine,
  RoutineExecutionError,
  type RoutineExecutionResult,
  type RoutineRunForResume,
} from "@/lib/routines/executor";
import { isRunTerminal, type RunStatus } from "@/lib/routines/runState";
import { emitServerEvent } from "@/lib/observability/events";

/**
 * Concentration-check routine (program §15.3) — a deterministic trigger that
 * turns a real portfolio into agent-Tasks and records a DURABLE, auditable run
 * (§15.5). No model, no fabricated data; it never trades.
 *
 * Existing behavior is preserved: POST without a runId opens a new run; POST
 * with a blocked/non-terminal runId resumes it by replaying succeeded step
 * snapshots and only running unfinished steps. Approval pauses resume through
 * POST /api/routines/runs/[id]/resume so the isActionable gate is centralized.
 */

type ConcentrationResponseOutput = {
  total: number;
  breaches: number;
  created: { id: string; objective: string }[];
  skipped: number;
};

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as { maxWeight?: number; runId?: string };
  const store = createSupabaseRoutineStore(supabase);

  try {
    let maxWeight = readMaxWeight(body.maxWeight);
    let result: RoutineExecutionResult<ConcentrationCheckOutputs>;

    if (typeof body.runId === "string" && body.runId) {
      const { data: run, error } = await supabase
        .from("routine_runs")
        .select("id, routine_key, routine_version, status, input_snapshot, paused_step_key, approval_id, idempotency_key")
        .eq("user_id", user.id)
        .eq("id", body.runId)
        .eq("routine_key", CONCENTRATION_CHECK_ROUTINE_KEY)
        .maybeSingle();
      if (error) return NextResponse.json({ error: "RUN_UNAVAILABLE" }, { status: 500 });
      if (!run) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
      if (isRunTerminal(run.status as RunStatus)) {
        return NextResponse.json({ error: "CANNOT_RESUME", status: run.status }, { status: 409 });
      }
      if (run.status === "waiting_for_approval") {
        return NextResponse.json(
          { error: "APPROVAL_REQUIRED", resumeUrl: `/api/routines/runs/${run.id}/resume` },
          { status: 409 },
        );
      }

      maxWeight = concentrationMaxWeightFromSnapshot(run.input_snapshot);
      result = await continueRoutineRun({
        store,
        userId: user.id,
        run: run as RoutineRunForResume,
        steps: concentrationCheckSteps({ supabase, userId: user.id, maxWeight }),
        buildRunOutput: buildConcentrationCheckOutput,
        failureStatus: "blocked",
      });
    } else {
      result = await executeRoutine({
        store,
        userId: user.id,
        routineKey: CONCENTRATION_CHECK_ROUTINE_KEY,
        inputSnapshot: { maxWeight },
        steps: concentrationCheckSteps({ supabase, userId: user.id, maxWeight }),
        buildRunOutput: buildConcentrationCheckOutput,
        failureStatus: "blocked",
      });
    }

    if (result.status === "waiting_for_approval") {
      return NextResponse.json({
        runId: result.runId,
        status: result.status,
        approvalId: result.approvalId,
      });
    }

    const output = result.output as unknown as ConcentrationResponseOutput;
    emitServerEvent("routine.run.completed", {
      routine: CONCENTRATION_CHECK_ROUTINE_KEY,
      runId: result.runId,
      status: result.status,
      breaches: output.breaches,
      tasksCreated: output.created.length,
      tasksSkipped: output.skipped,
    });

    return NextResponse.json({ runId: result.runId, status: result.status, ...output });
  } catch (err) {
    const runId = err instanceof RoutineExecutionError ? err.runId : body.runId;
    emitServerEvent("routine.run.blocked", {
      routine: CONCENTRATION_CHECK_ROUTINE_KEY,
      runId,
      error: err instanceof Error ? err.message : "run failed",
    });
    return NextResponse.json({ error: "RUN_BLOCKED", runId, resumable: true }, { status: 500 });
  }
}

function readMaxWeight(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0.25;
}
