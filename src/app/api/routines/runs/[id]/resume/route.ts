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
import { emitServerEvent } from "@/lib/observability/events";
import { rowToApprovalRequest, type ApprovalRow } from "@/lib/security/approvalPersistence";
import {
  isActionable,
  isApprovalExpired,
  validateApprovalCompleteness,
} from "@/lib/security/approvalRequest";

const APPROVAL_SELECT =
  "id, task_id, action_class, requirement, reasons, proposed_action, status, step_up_verified_at, expires_at, scope";

type ApprovalResumeRow = ApprovalRow & {
  id: string;
  status: string;
};

type ConcentrationResponseOutput = {
  total: number;
  breaches: number;
  created: { id: string; objective: string }[];
  skipped: number;
};

/**
 * Resume a durable routine run that paused for an approval. This endpoint is
 * intentionally only a resume gate: it verifies the stored approval row with
 * isActionable, consumes that approval record, replays already-completed step
 * outputs from routine_step_runs, and continues from the paused step. It does
 * not place trades or perform autonomous financial execution.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: run, error: runError } = await supabase
    .from("routine_runs")
    .select("id, routine_key, routine_version, status, input_snapshot, paused_step_key, approval_id, idempotency_key")
    .eq("user_id", user.id)
    .eq("id", id)
    .maybeSingle();
  if (runError) return NextResponse.json({ error: "RUN_UNAVAILABLE" }, { status: 500 });
  if (!run) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  if (run.status !== "waiting_for_approval") {
    return NextResponse.json({ error: "RUN_NOT_WAITING_FOR_APPROVAL", status: run.status }, { status: 409 });
  }
  if (!run.paused_step_key || !run.approval_id) {
    return NextResponse.json({ error: "RUN_PAUSE_METADATA_MISSING" }, { status: 409 });
  }

  if (run.routine_key !== CONCENTRATION_CHECK_ROUTINE_KEY) {
    return NextResponse.json({ error: "UNSUPPORTED_ROUTINE", routine: run.routine_key }, { status: 409 });
  }

  const approvalCheck = await verifyAndConsumeApproval({
    supabase,
    userId: user.id,
    approvalId: run.approval_id,
  });
  if (!approvalCheck.ok) {
    return NextResponse.json(approvalCheck.body, { status: approvalCheck.status });
  }

  const maxWeight = concentrationMaxWeightFromSnapshot(run.input_snapshot);

  try {
    const result = await resumeRoutine({
      store: createSupabaseRoutineStore(supabase),
      userId: user.id,
      run: run as RoutineRunForResume,
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
    emitServerEvent("routine.run.blocked", {
      routine: run.routine_key,
      runId,
      error: err instanceof Error ? err.message : "run failed",
      resumedFromApproval: true,
    });
    return NextResponse.json({ error: "RUN_BLOCKED", runId, resumable: true }, { status: 500 });
  }
}

async function verifyAndConsumeApproval(input: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  userId: string;
  approvalId: string;
}): Promise<
  | { ok: true }
  | { ok: false; status: number; body: Record<string, unknown> }
> {
  const { data: approval, error } = await input.supabase
    .from("approvals")
    .select(APPROVAL_SELECT)
    .eq("user_id", input.userId)
    .eq("id", input.approvalId)
    .maybeSingle();
  if (error) return { ok: false, status: 500, body: { error: "APPROVAL_UNAVAILABLE" } };
  if (!approval) return { ok: false, status: 404, body: { error: "APPROVAL_NOT_FOUND" } };
  if (approval.status !== "approved") {
    return {
      ok: false,
      status: 409,
      body: { error: "APPROVAL_NOT_APPROVED", status: approval.status },
    };
  }

  const request = rowToApprovalRequest(approval as ApprovalResumeRow);
  const nowMs = Date.now();
  if (isApprovalExpired(request, nowMs)) {
    await input.supabase
      .from("approvals")
      .update({ status: "expired" })
      .eq("user_id", input.userId)
      .eq("id", input.approvalId);
    return { ok: false, status: 409, body: { error: "APPROVAL_EXPIRED" } };
  }

  if (!isActionable(request, { stepUpVerifiedAt: approval.step_up_verified_at, nowMs })) {
    return {
      ok: false,
      status: 409,
      body: {
        error: "APPROVAL_NOT_ACTIONABLE",
        reason: request.stepUpRequired && !approval.step_up_verified_at ? "STEP_UP_REQUIRED" : "INCOMPLETE",
        missing: validateApprovalCompleteness(request).missing,
      },
    };
  }

  const { data: consumed, error: consumeError } = await input.supabase
    .from("approvals")
    .update({ status: "executed" })
    .eq("user_id", input.userId)
    .eq("id", input.approvalId)
    .eq("status", "approved")
    .select("id")
    .maybeSingle();
  if (consumeError) return { ok: false, status: 500, body: { error: "APPROVAL_UPDATE_FAILED" } };
  if (!consumed) return { ok: false, status: 409, body: { error: "APPROVAL_ALREADY_CONSUMED" } };

  return { ok: true };
}
