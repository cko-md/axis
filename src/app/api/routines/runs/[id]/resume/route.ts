import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database, Json } from "@/lib/supabase/database.types";
import {
  buildConcentrationCheckOutput,
  concentrationCheckSteps,
  concentrationMaxWeightFromSnapshot,
  CONCENTRATION_CHECK_ROUTINE_KEY,
} from "@/lib/routines/concentrationCheck";
import {
  createSupabaseRoutineStore,
  normalizeRoutineError,
  resumeRoutine,
  RoutineExecutionError,
  type RoutineRunForResume,
} from "@/lib/routines/executor";
import { emitServerEvent } from "@/lib/observability/events";
import { captureRouteError } from "@/lib/observability/captureRouteError";
import { rowToApprovalRequest, type ApprovalRow } from "@/lib/security/approvalPersistence";
import {
  isActionable,
  isApprovalExpired,
  validateApprovalCompleteness,
} from "@/lib/security/approvalRequest";

const ROUTE = "routines.runs.resume";
const APPROVAL_SELECT =
  "id, task_id, action_class, requirement, reasons, proposed_action, status, step_up_verified_at, expires_at, scope, execution_claim_token, execution_run_id";
const RUN_SELECT =
  "id, routine_key, routine_version, status, input_snapshot, output, paused_step_key, approval_id, idempotency_key, resume_claim_token, resume_claimed_at";

type ApprovalResumeRow = ApprovalRow & {
  id: string;
  status: string;
  execution_claim_token: string | null;
  execution_run_id: string | null;
};

type ResumeRunRow = RoutineRunForResume & {
  output: Json | null;
  resume_claimed_at: string | null;
};

type ConcentrationResponseOutput = {
  total: number;
  breaches: number;
  created: { id: string; objective: string }[];
  skipped: number;
};

type ClaimResult = {
  ok: boolean;
  code?: string;
  claimToken?: string;
};

/**
 * Atomically claims the waiting run and its approved approval, replays durable
 * steps, then atomically finalizes or releases both records. This endpoint does
 * not trade or perform autonomous financial execution.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  if (!admin) {
    return NextResponse.json({ error: "RESUME_SERVICE_NOT_CONFIGURED" }, { status: 503 });
  }

  const runRead = await readRun(supabase, user.id, id);
  if (!runRead.ok) return runRead.response;
  let run = runRead.run;

  if (run.routine_key !== CONCENTRATION_CHECK_ROUTINE_KEY) {
    return NextResponse.json(
      { error: "UNSUPPORTED_ROUTINE", routine: run.routine_key },
      { status: 409 },
    );
  }
  if (run.status === "completed" || run.status === "partial") {
    return terminalRunResponse(run);
  }
  if (run.status === "running") {
    if (!run.approval_id || !run.resume_claim_token) {
      return NextResponse.json({ error: "RUN_ALREADY_RESUMING" }, { status: 409 });
    }
    const recovery = await admin.rpc("recover_stale_routine_approval_resume", {
      p_user_id: user.id,
      p_run_id: run.id,
      p_approval_id: run.approval_id,
    });
    if (recovery.error) {
      captureRouteError(new Error("RUN_STALE_CLAIM_CHECK_FAILED"), {
        route: ROUTE,
        operation: "recover_stale_claim",
        area: "routines",
        status: 500,
        code: "RUN_STALE_CLAIM_CHECK_FAILED",
      });
      return NextResponse.json({ error: "RUN_STALE_CLAIM_CHECK_FAILED" }, { status: 500 });
    }
    const refreshed = await readRun(supabase, user.id, id);
    if (!refreshed.ok) return refreshed.response;
    run = refreshed.run;
    if (recovery.data) {
      return NextResponse.json(
        {
          error: "RUN_STALE_CLAIM_REQUIRES_REVIEW",
          status: run.status,
        },
        { status: 409 },
      );
    }
    if (run.status === "completed" || run.status === "partial") {
      return terminalRunResponse(run);
    }
    if (run.status === "running") {
      return NextResponse.json({ error: "RUN_ALREADY_RESUMING" }, { status: 409 });
    }
  }
  if (run.status !== "waiting_for_approval") {
    return NextResponse.json(
      { error: "RUN_NOT_WAITING_FOR_APPROVAL", status: run.status },
      { status: 409 },
    );
  }
  if (!run.paused_step_key || !run.approval_id) {
    return NextResponse.json({ error: "RUN_PAUSE_METADATA_MISSING" }, { status: 409 });
  }

  const approvalCheck = await verifyApproval({
    supabase,
    admin,
    userId: user.id,
    approvalId: run.approval_id,
    run,
  });
  if (!approvalCheck.ok) return approvalCheck.response;

  // The caller generates the token so a committed claim remains recoverable if
  // the database response is lost after commit.
  const claimToken = crypto.randomUUID();
  const claim = await claimResume({
    admin,
    userId: user.id,
    runId: run.id,
    approvalId: run.approval_id,
    claimToken,
  });
  if (!claim.ok) {
    if (claim.response) return claim.response;
    const recovered = await inspectResumeState(admin, user.id, run.id, run.approval_id);
    if (recovered.run?.resume_claim_token !== claimToken) {
      return NextResponse.json({ error: "RUN_CLAIM_FAILED" }, { status: 500 });
    }
  }

  const maxWeight = concentrationMaxWeightFromSnapshot(run.input_snapshot);
  const claimedRun: RoutineRunForResume = {
    ...run,
    resume_claim_token: claimToken,
  };

  try {
    const result = await resumeRoutine({
      store: createSupabaseRoutineStore(admin, {
        resumeApprovalClaim: {
          userId: user.id,
          approvalId: run.approval_id,
          claimToken,
        },
      }),
      userId: user.id,
      run: claimedRun,
      preclaimed: true,
      steps: concentrationCheckSteps({
        supabase,
        taskAdmin: admin,
        userId: user.id,
        maxWeight,
      }),
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

    const output = parseConcentrationOutput(result.output);
    if (!output) {
      throw new RoutineExecutionError("RUN_OUTPUT_INVALID", result.runId);
    }
    emitCompletion(result.runId, result.status, output);
    return NextResponse.json({ runId: result.runId, status: result.status, ...output });
  } catch (error) {
    const code = normalizeRoutineError(error);
    const release = await admin.rpc("release_routine_approval_resume", {
      p_user_id: user.id,
      p_run_id: run.id,
      p_approval_id: run.approval_id,
      p_claim_token: claimToken,
      p_error: code,
    });
    if (release.error) {
      captureRouteError(new Error("RUN_RELEASE_FAILED"), {
        route: ROUTE,
        operation: "release_claim",
        area: "routines",
        status: 500,
        code: "RUN_RELEASE_FAILED",
      });
    }

    const state = await inspectResumeState(admin, user.id, run.id, run.approval_id);
    if (state.run?.status === "completed" || state.run?.status === "partial") {
      return terminalRunResponse(state.run);
    }
    if (
      state.run?.status === "waiting_for_approval" &&
      state.run.approval_id &&
      state.run.approval_id !== run.approval_id &&
      !state.run.resume_claim_token
    ) {
      return NextResponse.json({
        runId: state.run.id,
        status: "waiting_for_approval",
        approvalId: state.run.approval_id,
      });
    }

    const resumable = state.run?.status === "waiting_for_approval" &&
      state.run.approval_id === run.approval_id &&
      !state.run.resume_claim_token &&
      state.approval?.status === "approved" &&
      !state.approval.execution_claim_token;

    captureRouteError(new Error(code), {
      route: ROUTE,
      operation: "resume",
      area: "routines",
      status: 500,
      code,
      tags: { resumable },
    });
    emitServerEvent("routine.run.blocked", {
      routine: run.routine_key,
      runId: error instanceof RoutineExecutionError ? error.runId : id,
      error: code,
      resumedFromApproval: true,
      resumable,
    });
    return NextResponse.json(
      {
        error: "RUN_BLOCKED",
        runId: error instanceof RoutineExecutionError ? error.runId : id,
        resumable,
      },
      { status: 500 },
    );
  }
}

async function readRun(
  supabase: SupabaseClient<Database>,
  userId: string,
  runId: string,
): Promise<
  | { ok: true; run: ResumeRunRow }
  | { ok: false; response: NextResponse }
> {
  const { data, error } = await supabase
    .from("routine_runs")
    .select(RUN_SELECT)
    .eq("user_id", userId)
    .eq("id", runId)
    .maybeSingle();
  if (error) {
    captureRouteError(error, {
      route: ROUTE,
      operation: "read_run",
      area: "routines",
      status: 500,
      code: "RUN_UNAVAILABLE",
    });
    return {
      ok: false,
      response: NextResponse.json({ error: "RUN_UNAVAILABLE" }, { status: 500 }),
    };
  }
  if (!data) {
    return {
      ok: false,
      response: NextResponse.json({ error: "NOT_FOUND" }, { status: 404 }),
    };
  }
  return { ok: true, run: data as ResumeRunRow };
}

async function verifyApproval(input: {
  supabase: SupabaseClient<Database>;
  admin: SupabaseClient<Database>;
  userId: string;
  approvalId: string;
  run: ResumeRunRow;
}): Promise<
  | { ok: true }
  | { ok: false; response: NextResponse }
> {
  const { data: approval, error } = await input.supabase
    .from("approvals")
    .select(APPROVAL_SELECT)
    .eq("user_id", input.userId)
    .eq("id", input.approvalId)
    .maybeSingle();
  if (error) {
    captureRouteError(error, {
      route: ROUTE,
      operation: "read_approval",
      area: "approvals",
      status: 500,
      code: "APPROVAL_UNAVAILABLE",
    });
    return {
      ok: false,
      response: NextResponse.json({ error: "APPROVAL_UNAVAILABLE" }, { status: 500 }),
    };
  }
  if (!approval) {
    return {
      ok: false,
      response: NextResponse.json({ error: "APPROVAL_NOT_FOUND" }, { status: 404 }),
    };
  }
  if (approval.status !== "approved") {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: approval.status === "executing"
            ? "RUN_ALREADY_RESUMING"
            : "APPROVAL_NOT_APPROVED",
          status: approval.status,
        },
        { status: 409 },
      ),
    };
  }
  if (approval.execution_claim_token || approval.execution_run_id) {
    return {
      ok: false,
      response: NextResponse.json({ error: "RUN_ALREADY_RESUMING" }, { status: 409 }),
    };
  }

  const request = rowToApprovalRequest(approval as ApprovalResumeRow);
  if (
    request.actor?.kind !== "routine" ||
    request.actor.id !== input.run.routine_key ||
    request.actor.routineVersion !== input.run.routine_version ||
    request.target?.entityType !== "routine_run" ||
    request.target.entityId !== input.run.id
  ) {
    return {
      ok: false,
      response: NextResponse.json({ error: "APPROVAL_SCOPE_MISMATCH" }, { status: 409 }),
    };
  }
  const nowMs = Date.now();
  if (isApprovalExpired(request, nowMs)) {
    const { data: expired, error: expireError } = await input.admin
      .from("approvals")
      .update({ status: "expired" })
      .eq("user_id", input.userId)
      .eq("id", input.approvalId)
      .eq("status", "approved")
      .select("id")
      .maybeSingle();
    if (expireError) {
      captureRouteError(expireError, {
        route: ROUTE,
        operation: "expire_approval",
        area: "approvals",
        status: 500,
        code: "APPROVAL_UPDATE_FAILED",
      });
      return {
        ok: false,
        response: NextResponse.json({ error: "APPROVAL_UPDATE_FAILED" }, { status: 500 }),
      };
    }
    return {
      ok: false,
      response: NextResponse.json(
        { error: expired ? "APPROVAL_EXPIRED" : "STALE_APPROVAL" },
        { status: 409 },
      ),
    };
  }

  if (!isActionable(request, { stepUpVerifiedAt: approval.step_up_verified_at, nowMs })) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: "APPROVAL_NOT_ACTIONABLE",
          reason: request.stepUpRequired && !approval.step_up_verified_at
            ? "STEP_UP_REQUIRED"
            : "INCOMPLETE_OR_STALE_STEP_UP",
          missing: validateApprovalCompleteness(request).missing,
        },
        { status: 409 },
      ),
    };
  }
  return { ok: true };
}

async function claimResume(input: {
  admin: SupabaseClient<Database>;
  userId: string;
  runId: string;
  approvalId: string;
  claimToken: string;
}): Promise<
  | { ok: true }
  | { ok: false; response?: NextResponse }
> {
  const { data, error } = await input.admin.rpc("claim_routine_approval_resume", {
    p_user_id: input.userId,
    p_run_id: input.runId,
    p_approval_id: input.approvalId,
    p_claim_token: input.claimToken,
  });
  if (error) {
    captureRouteError(new Error("RUN_CLAIM_FAILED"), {
      route: ROUTE,
      operation: "claim",
      area: "routines",
      status: 500,
      code: "RUN_CLAIM_FAILED",
    });
    return { ok: false };
  }

  const result = parseClaimResult(data);
  if (result.ok) return { ok: true };
  const code = result.code ?? "RUN_CLAIM_REJECTED";
  const status = code.endsWith("_NOT_FOUND") ? 404 : 409;
  const publicCode = code === "RUN_ALREADY_CLAIMED" || code === "APPROVAL_ALREADY_CLAIMED"
    ? "RUN_ALREADY_RESUMING"
    : code;
  return {
    ok: false,
    response: NextResponse.json({ error: publicCode }, { status }),
  };
}

async function inspectResumeState(
  admin: SupabaseClient<Database>,
  userId: string,
  runId: string,
  approvalId: string,
) {
  const [runResult, approvalResult] = await Promise.all([
    admin
      .from("routine_runs")
      .select(RUN_SELECT)
      .eq("user_id", userId)
      .eq("id", runId)
      .maybeSingle(),
    admin
      .from("approvals")
      .select("id, status, execution_claim_token, execution_run_id")
      .eq("user_id", userId)
      .eq("id", approvalId)
      .maybeSingle(),
  ]);
  if (runResult.error || approvalResult.error) {
    captureRouteError(new Error("RUN_RECOVERY_INSPECTION_FAILED"), {
      route: ROUTE,
      operation: "inspect_recovery",
      area: "routines",
      status: 500,
      code: "RUN_RECOVERY_INSPECTION_FAILED",
    });
  }
  return {
    run: runResult.data as ResumeRunRow | null,
    approval: approvalResult.data as {
      id: string;
      status: string;
      execution_claim_token: string | null;
      execution_run_id: string | null;
    } | null,
  };
}

function terminalRunResponse(run: ResumeRunRow): NextResponse {
  const output = parseConcentrationOutput(run.output);
  if (!output) {
    captureRouteError(new Error("RUN_OUTPUT_INVALID"), {
      route: ROUTE,
      operation: "read_terminal_output",
      area: "routines",
      status: 500,
      code: "RUN_OUTPUT_INVALID",
    });
    return NextResponse.json({ error: "RUN_OUTPUT_INVALID" }, { status: 500 });
  }
  return NextResponse.json({ runId: run.id, status: run.status, ...output });
}

function parseClaimResult(value: Json): ClaimResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false };
  return {
    ok: value.ok === true,
    code: typeof value.code === "string" ? value.code : undefined,
    claimToken: typeof value.claimToken === "string" ? value.claimToken : undefined,
  };
}

function parseConcentrationOutput(value: Json | null): ConcentrationResponseOutput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (
    typeof value.total !== "number" ||
    typeof value.breaches !== "number" ||
    typeof value.skipped !== "number" ||
    !Array.isArray(value.created)
  ) {
    return null;
  }
  const created = value.created.filter(
    (entry): entry is { id: string; objective: string } =>
      !!entry &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      typeof entry.id === "string" &&
      typeof entry.objective === "string",
  );
  if (created.length !== value.created.length) return null;
  return {
    total: value.total,
    breaches: value.breaches,
    created,
    skipped: value.skipped,
  };
}

function emitCompletion(
  runId: string,
  status: string,
  output: ConcentrationResponseOutput,
) {
  emitServerEvent("routine.run.completed", {
    routine: CONCENTRATION_CHECK_ROUTINE_KEY,
    runId,
    status,
    breaches: output.breaches,
    tasksCreated: output.created.length,
    tasksSkipped: output.skipped,
    resumedFromApproval: true,
  });
}
