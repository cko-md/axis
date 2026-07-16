import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  buildConcentrationCheckOutput,
  concentrationCheckSteps,
  concentrationMaxWeightFromSnapshot,
  CONCENTRATION_CHECK_ROUTINE_KEY,
} from "@/lib/routines/concentrationCheck";
import {
  createSupabaseRoutineStore,
  resumeRoutine,
  RoutineExecutionError,
  type RoutineRunForResume,
} from "@/lib/routines/executor";
import {
  createRoutineResumeClaims,
  type RoutineResumeFailure,
  type TerminalRoutineResume,
} from "@/lib/routines/resumeClaims";
import { captureRouteError } from "@/lib/observability/captureRouteError";
import { emitServerEvent } from "@/lib/observability/events";

type ConcentrationResponseOutput = {
  total: number;
  breaches: number;
  created: { id: string; objective: string }[];
  skipped: number;
};

/**
 * Resume a durable routine run that paused for an approval. This endpoint is
 * intentionally only a resume gate: a service-only transaction verifies the
 * stored approval and claims the run before any resumed work starts. Approval
 * consumption is deferred until the same transaction that finalizes the run.
 * It does not place trades or perform autonomous financial execution.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const claims = createRoutineResumeClaims();
  const claimToken = randomUUID();
  const claim = await claims.claim({
    userId: user.id,
    runId: id,
    claimToken,
  });
  if (!claim.ok) return resumeFailureResponse(claim, id, "claim");
  if (claim.value.kind === "terminal") {
    return NextResponse.json(terminalResponseBody(claim.value));
  }

  const claimed = claim.value;
  if (claimed.routineKey !== CONCENTRATION_CHECK_ROUTINE_KEY) {
    const released = await claims.release({
      userId: user.id,
      runId: claimed.runId,
      claimToken,
      errorCode: null,
    });
    if (!released.ok) {
      return resumeFailureResponse(released, claimed.runId, "release_unsupported");
    }
    return NextResponse.json(
      { error: "UNSUPPORTED_ROUTINE", routine: claimed.routineKey },
      { status: 409 },
    );
  }

  const run: RoutineRunForResume = {
    id: claimed.runId,
    routine_key: claimed.routineKey,
    routine_version: claimed.routineVersion,
    status: "running",
    input_snapshot: claimed.inputSnapshot,
    paused_step_key: claimed.stepKey,
    approval_id: claimed.approvalId,
    idempotency_key: claimed.idempotencyKey,
  };
  const maxWeight = concentrationMaxWeightFromSnapshot(run.input_snapshot);

  try {
    const result = await resumeRoutine({
      store: createSupabaseRoutineStore(supabase, { claimToken, claims }),
      userId: user.id,
      run,
      steps: concentrationCheckSteps({ supabase, userId: user.id, maxWeight }),
      buildRunOutput: buildConcentrationCheckOutput,
      failureStatus: "blocked",
    });

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
      resumedFromApproval: true,
    });

    return NextResponse.json({ runId: result.runId, status: result.status, ...output });
  } catch (err) {
    const runId = err instanceof RoutineExecutionError ? err.runId : id;
    const errorCode = err instanceof Error ? err.message : "ROUTINE_RESUME_FAILED";
    captureRouteError(err, {
      route: "/api/routines/runs/[id]/resume",
      operation: "execute_claimed_resume",
      area: "routines",
      status: 500,
      code: errorCode,
      tags: { runId, routine: run.routine_key },
    });
    emitServerEvent("routine.run.blocked", {
      routine: run.routine_key,
      runId,
      error: errorCode,
      resumedFromApproval: true,
    });
    return NextResponse.json({ error: "RUN_BLOCKED", runId, resumable: true }, { status: 500 });
  }
}

function resumeFailureResponse(
  failure: RoutineResumeFailure,
  runId: string,
  operation: string,
) {
  const statuses: Record<RoutineResumeFailure["code"], number> = {
    SERVICE_UNAVAILABLE: 503,
    RPC_FAILED: 500,
    INVALID_RESPONSE: 500,
    RECONCILIATION_FAILED: 500,
    NOT_FOUND: 404,
    BUSY: 409,
    TERMINAL: 409,
    NOT_RESUMABLE: 409,
    PAUSE_METADATA_MISSING: 409,
    APPROVAL_NOT_APPROVED: 409,
    APPROVAL_NOT_ACTIONABLE: 409,
    APPROVAL_EXPIRED: 409,
    STEP_UP_STALE: 409,
    CLAIM_LOST: 409,
    REPLACEMENT_APPROVAL_NOT_FOUND: 409,
    REPLACEMENT_APPROVAL_NOT_PENDING: 409,
    STEPS_INCOMPLETE: 409,
    STEP_NOT_FOUND: 409,
    STEP_CONFLICT: 409,
  };
  const status = statuses[failure.code];
  if (status >= 500) {
    captureRouteError(new Error(failure.code), {
      route: "/api/routines/runs/[id]/resume",
      operation,
      area: "routines",
      status,
      code: failure.code,
      tags: { runId },
    });
  }
  return NextResponse.json(
    {
      error: failure.code,
      runId,
      ...(failure.currentStatus ? { status: failure.currentStatus } : {}),
      ...(failure.claimExpiresAt ? { claimExpiresAt: failure.claimExpiresAt } : {}),
      resumable: failure.code !== "NOT_FOUND",
    },
    { status },
  );
}

function terminalResponseBody(terminal: TerminalRoutineResume): Record<string, unknown> {
  const output = terminal.output
    && typeof terminal.output === "object"
    && !Array.isArray(terminal.output)
    ? terminal.output as Record<string, unknown>
    : { output: terminal.output };
  return {
    ...output,
    runId: terminal.runId,
    status: terminal.status,
    actualCostUsd: terminal.actualCostUsd,
    completedAt: terminal.completedAt,
    idempotentReplay: true,
  };
}
