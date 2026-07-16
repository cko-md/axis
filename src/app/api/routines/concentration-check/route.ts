import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import {
  buildConcentrationCheckOutput,
  concentrationCheckSteps,
  concentrationMaxWeightFromBps,
  concentrationMaxWeightFromSnapshot,
  CONCENTRATION_CHECK_ROUTINE_KEY,
  normalizeConcentrationMaxWeight,
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
import { captureRouteError } from "@/lib/observability/captureRouteError";
import {
  createObservabilityRequestId,
  emitServerEvent,
  routineEventErrorCode,
} from "@/lib/observability/events";

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

const concentrationRequestSchema = z.object({
  maxWeight: z.number().finite().gt(0).max(1).optional(),
  runId: z.string().uuid().optional(),
}).strict();

export async function POST(request: NextRequest) {
  const requestId = createObservabilityRequestId();
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsedBody = concentrationRequestSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsedBody.success) {
    return NextResponse.json({ error: "INVALID_ROUTINE_INPUT" }, { status: 400 });
  }
  const body = parsedBody.data;
  const store = createSupabaseRoutineStore(supabase);

  try {
    let maxWeight = normalizeConcentrationMaxWeight(body.maxWeight) ?? 0.25;
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
      const explicitMaxWeight = normalizeConcentrationMaxWeight(body.maxWeight);
      let maxWeightProvenance: { source_type: string; confirmed_at?: string } = { source_type: "routine_default" };
      if (explicitMaxWeight !== null) {
        maxWeight = explicitMaxWeight;
        maxWeightProvenance = { source_type: "request" };
      } else {
        const { data: profile, error: profileError } = await supabase
          .from("financial_operating_profiles")
          .select("concentration_limit_bps, confirmed_at")
          .eq("user_id", user.id)
          .maybeSingle();
        if (profileError) throw new Error("FINANCIAL_PROFILE_UNAVAILABLE");
        const profileWeight = concentrationMaxWeightFromBps(profile?.concentration_limit_bps);
        if (profileWeight !== null && profile) {
          maxWeight = profileWeight;
          maxWeightProvenance = { source_type: "financial_operating_profile", confirmed_at: profile.confirmed_at };
        }
      }
      result = await executeRoutine({
        store,
        userId: user.id,
        routineKey: CONCENTRATION_CHECK_ROUTINE_KEY,
        inputSnapshot: { maxWeight, maxWeightProvenance },
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
      requestId,
      routine: CONCENTRATION_CHECK_ROUTINE_KEY,
      runId: result.runId,
      status: "completed",
      breaches: output.breaches,
      tasksCreated: output.created.length,
      tasksSkipped: output.skipped,
      resumedFromApproval: false,
    });

    return NextResponse.json({ runId: result.runId, status: result.status, ...output });
  } catch (err) {
    const runId = err instanceof RoutineExecutionError ? err.runId : body.runId;
    const errorCode = routineEventErrorCode(err);
    captureRouteError(new Error(errorCode), {
      route: "/api/routines/concentration-check",
      operation: "execute",
      area: "routines",
      status: 500,
      code: errorCode,
      tags: {
        requestId,
        ...(runId ? { runId } : {}),
        routine: CONCENTRATION_CHECK_ROUTINE_KEY,
      },
    });
    emitServerEvent("routine.run.blocked", {
      requestId,
      routine: CONCENTRATION_CHECK_ROUTINE_KEY,
      runId,
      errorCode,
      stage: "execute",
      resumedFromApproval: false,
    });
    return NextResponse.json({ error: "RUN_BLOCKED", runId, resumable: true }, { status: 500 });
  }
}
