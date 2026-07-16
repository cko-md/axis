import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/database.types";
import {
  deriveRunOutcome,
  requiresRoutineOperatorReview,
  type RunStatus,
  type StepStatus,
} from "@/lib/routines/runState";

export const PAUSE_FOR_APPROVAL = "pause_for_approval" as const;

export type RoutinePauseSignal = {
  kind: typeof PAUSE_FOR_APPROVAL;
  approvalId: string;
  idempotencyKey?: string;
};

export type RoutineStepContext<TOutputs extends Record<string, unknown>> = {
  runId: string;
  userId: string;
  outputs: Partial<TOutputs>;
  resumed: boolean;
  claimToken: string | null;
  assertClaimActive: () => Promise<void>;
};

export type RoutineStep<TOutputs extends Record<string, unknown>> = {
  key: keyof TOutputs & string;
  input?: (context: RoutineStepContext<TOutputs>) => Json;
  run: (context: RoutineStepContext<TOutputs>) => Promise<TOutputs[keyof TOutputs] | RoutinePauseSignal>;
};

export type RoutineStepRunSnapshot = {
  id: string;
  step_key: string;
  ordinal: number;
  status: StepStatus;
  output_snapshot: Json | null;
};

export type RoutineRunForResume = {
  id: string;
  routine_key: string;
  routine_version: number;
  status: RunStatus;
  input_snapshot: Json;
  paused_step_key: string | null;
  approval_id: string | null;
  idempotency_key: string | null;
  error?: string | null;
  resume_claim_token?: string | null;
  resume_claim_expires_at?: string | null;
};

export type RoutineApprovalResumeClaim = {
  userId: string;
  approvalId: string;
  claimToken: string;
};

type CreateRunInput = {
  userId: string;
  routineKey: string;
  routineVersion: number;
  trigger: string;
  inputSnapshot: Json;
  estimatedCostUsd: number;
};

type StartStepInput = {
  runId: string;
  userId: string;
  stepKey: string;
  ordinal: number;
  inputSnapshot: Json;
};

type CompleteStepInput = {
  stepRunId: string;
  runId: string;
  userId: string;
  outputSnapshot: Json;
};

type FailStepInput = {
  stepRunId: string;
  runId: string;
  userId: string;
  error: string;
};

type CompleteRunInput = {
  runId: string;
  userId: string;
  status: RunStatus;
  output: Json;
  actualCostUsd: number;
};

type FailRunInput = {
  runId: string;
  userId: string;
  status: "blocked" | "failed";
  error: string;
};

type PauseRunInput = {
  runId: string;
  userId: string;
  pausedStepKey: string;
  approvalId: string;
  idempotencyKey: string | null;
};

export type RoutineExecutionStore = {
  createRun(input: CreateRunInput): Promise<{ id: string }>;
  listStepRuns(runId: string, userId: string): Promise<RoutineStepRunSnapshot[]>;
  startStep(input: StartStepInput): Promise<{ id: string; ordinal: number }>;
  completeStep(input: CompleteStepInput): Promise<void>;
  failStep(input: FailStepInput): Promise<void>;
  /** Renew and verify an approval-resume lease. No-op outside a fenced resume. */
  renewRunClaim(runId: string, userId: string): Promise<void>;
  /** Claim a waiting run. `false` means another resume already claimed it. */
  markRunRunning(runId: string, userId: string, expectedStatus?: RunStatus): Promise<boolean>;
  markRunWaitingForApproval(input: PauseRunInput): Promise<void>;
  completeRun(input: CompleteRunInput): Promise<void>;
  failRun(input: FailRunInput): Promise<void>;
};

export type ExecuteRoutineOptions<TOutputs extends Record<string, unknown>> = {
  store: RoutineExecutionStore;
  userId: string;
  routineKey: string;
  routineVersion?: number;
  trigger?: string;
  inputSnapshot?: Json;
  estimatedCostUsd?: number;
  actualCostUsd?: number;
  failureStatus?: "blocked" | "failed";
  steps: readonly RoutineStep<TOutputs>[];
  buildRunOutput: (outputs: Partial<TOutputs>) => Json;
};

export type ResumeRoutineOptions<TOutputs extends Record<string, unknown>> = {
  store: RoutineExecutionStore;
  userId: string;
  run: RoutineRunForResume;
  steps: readonly RoutineStep<TOutputs>[];
  actualCostUsd?: number;
  failureStatus?: "blocked" | "failed";
  /**
   * The caller already atomically claimed both the run and its approval.
   * The snapshot must carry that claim token so this cannot accidentally
   * bypass the compare-and-set path.
   */
  preclaimed?: boolean;
  buildRunOutput: (outputs: Partial<TOutputs>) => Json;
};

export type RoutineExecutionResult<TOutputs extends Record<string, unknown>> =
  | {
      status: Exclude<RunStatus, "waiting_for_approval">;
      runId: string;
      output: Json;
      outputs: Partial<TOutputs>;
    }
  | {
      status: "waiting_for_approval";
      runId: string;
      pausedStepKey: string;
      approvalId: string;
      idempotencyKey: string | null;
      outputs: Partial<TOutputs>;
    };

export class RoutineExecutionError extends Error {
  constructor(
    message: string,
    readonly runId: string,
  ) {
    super(message);
    this.name = "RoutineExecutionError";
  }
}

export function pauseForApproval(approvalId: string, idempotencyKey?: string): RoutinePauseSignal {
  return { kind: PAUSE_FOR_APPROVAL, approvalId, idempotencyKey };
}

export function isPauseSignal(value: unknown): value is RoutinePauseSignal {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { kind?: unknown }).kind === PAUSE_FOR_APPROVAL &&
    typeof (value as { approvalId?: unknown }).approvalId === "string" &&
    (value as { approvalId: string }).approvalId.length > 0
  );
}

export function createSupabaseRoutineStore(
  supabase: SupabaseClient<Database>,
  options: {
    resumeApprovalClaim?: RoutineApprovalResumeClaim;
    resumeApprovalClient?: SupabaseClient<Database>;
  } = {},
): RoutineExecutionStore {
  const resumeClaim = options.resumeApprovalClaim;
  const resumeClient = options.resumeApprovalClient ?? supabase;

  async function repauseCommitted(input: PauseRunInput): Promise<boolean> {
    const { data, error } = await resumeClient
      .from("routine_runs")
      .select("status, approval_id, paused_step_key, idempotency_key, resume_claim_token")
      .eq("user_id", input.userId)
      .eq("id", input.runId)
      .maybeSingle();
    if (error) throw new Error("RUN_REPAUSE_STATE_UNAVAILABLE");
    return data?.status === "waiting_for_approval" &&
      data.approval_id === input.approvalId &&
      data.paused_step_key === input.pausedStepKey &&
      data.idempotency_key === input.idempotencyKey &&
      data.resume_claim_token === null;
  }

  return {
    async createRun(input) {
      const { data, error } = await supabase
        .from("routine_runs")
        .insert({
          user_id: input.userId,
          routine_key: input.routineKey,
          routine_version: input.routineVersion,
          status: "running",
          trigger: input.trigger,
          input_snapshot: input.inputSnapshot,
          estimated_cost_usd: input.estimatedCostUsd,
        })
        .select("id")
        .single();
      if (error || !data) throw new Error("RUN_START_FAILED");
      return data;
    },

    async listStepRuns(runId, userId) {
      const { data, error } = await supabase
        .from("routine_step_runs")
        .select("id, step_key, ordinal, status, output_snapshot")
        .eq("user_id", userId)
        .eq("run_id", runId)
        .order("ordinal", { ascending: true })
        .order("created_at", { ascending: true });
      if (error) throw new Error("RUN_STEPS_UNAVAILABLE");
      return (data ?? []).map((row) => ({
        id: row.id,
        step_key: row.step_key,
        ordinal: row.ordinal,
        status: row.status as StepStatus,
        output_snapshot: row.output_snapshot,
      }));
    },

    async startStep(input) {
      if (resumeClaim) {
        const { data, error } = await resumeClient.rpc(
          "start_routine_step_under_claim",
          {
            p_user_id: resumeClaim.userId,
            p_run_id: input.runId,
            p_approval_id: resumeClaim.approvalId,
            p_claim_token: resumeClaim.claimToken,
            p_step_key: input.stepKey,
            p_ordinal: input.ordinal,
            p_input_snapshot: input.inputSnapshot,
          },
        );
        if (error || !isStepStartResult(data)) {
          throw new Error("STEP_START_CLAIM_LOST");
        }
        return data;
      }

      const { data, error } = await supabase
        .from("routine_step_runs")
        .insert({
          run_id: input.runId,
          user_id: input.userId,
          step_key: input.stepKey,
          ordinal: input.ordinal,
          status: "running",
          input_snapshot: input.inputSnapshot,
          started_at: new Date().toISOString(),
        })
        .select("id, ordinal")
        .single();
      if (error || !data) throw new Error("STEP_START_FAILED");
      return data;
    },

    async completeStep(input) {
      if (resumeClaim) {
        const { data, error } = await resumeClient.rpc(
          "complete_routine_step_under_claim",
          {
            p_user_id: resumeClaim.userId,
            p_run_id: input.runId,
            p_approval_id: resumeClaim.approvalId,
            p_claim_token: resumeClaim.claimToken,
            p_step_run_id: input.stepRunId,
            p_output_snapshot: input.outputSnapshot,
          },
        );
        if (!error && data) return;

        const { data: persisted, error: recoveryError } = await supabase
          .from("routine_step_runs")
          .select("status")
          .eq("user_id", input.userId)
          .eq("run_id", input.runId)
          .eq("id", input.stepRunId)
          .maybeSingle();
        if (!recoveryError && persisted?.status === "succeeded") return;
        throw new Error("STEP_COMPLETE_CLAIM_LOST");
      }

      const { error } = await supabase
        .from("routine_step_runs")
        .update({
          status: "succeeded",
          output_snapshot: input.outputSnapshot,
          completed_at: new Date().toISOString(),
        })
        .eq("user_id", input.userId)
        .eq("run_id", input.runId)
        .eq("id", input.stepRunId);
      if (!error) return;

      // A network response can be lost after Postgres commits. Re-read the
      // server-owned step before reporting failure so retry does not duplicate
      // the step's already-completed side effects.
      const { data: persisted, error: recoveryError } = await supabase
        .from("routine_step_runs")
        .select("status")
        .eq("user_id", input.userId)
        .eq("run_id", input.runId)
        .eq("id", input.stepRunId)
        .maybeSingle();
      if (!recoveryError && persisted?.status === "succeeded") return;
      throw new Error("STEP_COMPLETE_FAILED");
    },

    async failStep(input) {
      if (resumeClaim) {
        const { data, error } = await resumeClient.rpc(
          "fail_routine_step_under_claim",
          {
            p_user_id: resumeClaim.userId,
            p_run_id: input.runId,
            p_approval_id: resumeClaim.approvalId,
            p_claim_token: resumeClaim.claimToken,
            p_step_run_id: input.stepRunId,
            p_error: input.error,
          },
        );
        if (error || !data) throw new Error("STEP_FAIL_CLAIM_LOST");
        return;
      }

      const { error } = await supabase
        .from("routine_step_runs")
        .update({
          status: "failed",
          error: input.error,
          completed_at: new Date().toISOString(),
        })
        .eq("user_id", input.userId)
        .eq("run_id", input.runId)
        .eq("id", input.stepRunId);
      if (error) throw new Error("STEP_FAIL_RECORD_FAILED");
    },

    async renewRunClaim(runId, userId) {
      if (!resumeClaim) return;
      if (userId !== resumeClaim.userId) {
        throw new Error("RUN_RESUME_CLAIM_LOST");
      }
      const { data, error } = await resumeClient.rpc(
        "renew_routine_approval_resume",
        {
          p_user_id: resumeClaim.userId,
          p_run_id: runId,
          p_approval_id: resumeClaim.approvalId,
          p_claim_token: resumeClaim.claimToken,
        },
      );
      if (!error && data) return;

      // The renewal may have committed even if its response was lost. Re-read
      // the fenced run before declaring the lease lost.
      const { data: persisted, error: recoveryError } = await resumeClient
        .from("routine_runs")
        .select("id")
        .eq("user_id", resumeClaim.userId)
        .eq("id", runId)
        .eq("status", "running")
        .eq("resume_claim_token", resumeClaim.claimToken)
        .gt("resume_claim_expires_at", new Date().toISOString())
        .maybeSingle();
      if (!recoveryError && persisted) return;
      throw new Error("RUN_RESUME_CLAIM_LOST");
    },

    async markRunRunning(runId, userId, expectedStatus = "waiting_for_approval") {
      const update = supabase
        .from("routine_runs")
        .update({ status: "running", error: null })
        .eq("user_id", userId)
        .eq("id", runId)
        .eq("status", expectedStatus);
      const guardedUpdate = expectedStatus === "blocked"
        ? update
            .is("paused_step_key", null)
            .is("approval_id", null)
            .is("resume_claim_token", null)
            .is("resume_claim_expires_at", null)
        : update;
      const { data, error } = await guardedUpdate
        .select("id")
        .maybeSingle();
      if (error) throw new Error("RUN_RESUME_FAILED");
      return !!data;
    },

    async markRunWaitingForApproval(input) {
      if (resumeClaim && resumeClient) {
        const { data, error } = await resumeClient.rpc("repause_routine_approval_resume", {
          p_user_id: resumeClaim.userId,
          p_run_id: input.runId,
          p_old_approval_id: resumeClaim.approvalId,
          p_claim_token: resumeClaim.claimToken,
          p_new_approval_id: input.approvalId,
          p_paused_step_key: input.pausedStepKey,
          p_idempotency_key: input.idempotencyKey,
        });
        if (error || !data) {
          if (await repauseCommitted(input)) return;
          throw new Error("RUN_REPAUSE_CLAIM_LOST");
        }
        return;
      }

      const { error } = await supabase
        .from("routine_runs")
        .update({
          status: "waiting_for_approval",
          paused_step_key: input.pausedStepKey,
          approval_id: input.approvalId,
          idempotency_key: input.idempotencyKey,
          error: null,
        })
        .eq("user_id", input.userId)
        .eq("id", input.runId);
      if (!error || await repauseCommitted(input)) return;
      throw new Error("RUN_PAUSE_FAILED");
    },

    async completeRun(input) {
      if (resumeClaim && resumeClient) {
        const { data, error } = await resumeClient.rpc("finalize_routine_approval_resume", {
          p_user_id: resumeClaim.userId,
          p_run_id: input.runId,
          p_approval_id: resumeClaim.approvalId,
          p_claim_token: resumeClaim.claimToken,
          p_status: input.status,
          p_output: input.output,
          p_actual_cost_usd: input.actualCostUsd,
        });
        if (error || !data) throw new Error("RUN_FINALIZE_CLAIM_LOST");
        return;
      }

      const { error } = await supabase
        .from("routine_runs")
        .update({
          status: input.status,
          output: input.output,
          actual_cost_usd: input.actualCostUsd,
          paused_step_key: null,
          approval_id: null,
          idempotency_key: null,
          completed_at: new Date().toISOString(),
        })
        .eq("user_id", input.userId)
        .eq("id", input.runId);
      if (!error) return;

      const { data: persisted, error: recoveryError } = await supabase
        .from("routine_runs")
        .select("status, completed_at")
        .eq("user_id", input.userId)
        .eq("id", input.runId)
        .maybeSingle();
      if (
        !recoveryError &&
        persisted?.status === input.status &&
        persisted.completed_at
      ) {
        return;
      }
      throw new Error("RUN_COMPLETE_FAILED");
    },

    async failRun(input) {
      if (resumeClaim && resumeClient) {
        const { data, error } = await resumeClient.rpc("release_routine_approval_resume", {
          p_user_id: resumeClaim.userId,
          p_run_id: input.runId,
          p_approval_id: resumeClaim.approvalId,
          p_claim_token: resumeClaim.claimToken,
          p_error: normalizeRoutineError(input.error),
        });
        if (error || !data) throw new Error("RUN_RELEASE_CLAIM_LOST");
        return;
      }

      const { error } = await supabase
        .from("routine_runs")
        .update({
          status: input.status,
          error: input.error,
          paused_step_key: null,
          approval_id: null,
          idempotency_key: null,
          completed_at: new Date().toISOString(),
        })
        .eq("user_id", input.userId)
        .eq("id", input.runId);
      if (error) throw new Error("RUN_FAIL_RECORD_FAILED");
    },
  };
}

export async function executeRoutine<TOutputs extends Record<string, unknown>>(
  options: ExecuteRoutineOptions<TOutputs>,
): Promise<RoutineExecutionResult<TOutputs>> {
  const run = await options.store.createRun({
    userId: options.userId,
    routineKey: options.routineKey,
    routineVersion: options.routineVersion ?? 1,
    trigger: options.trigger ?? "manual",
    inputSnapshot: options.inputSnapshot ?? {},
    estimatedCostUsd: options.estimatedCostUsd ?? 0,
  });

  return runRoutineSteps({
    store: options.store,
    userId: options.userId,
    runId: run.id,
    steps: options.steps,
    buildRunOutput: options.buildRunOutput,
    actualCostUsd: options.actualCostUsd ?? 0,
    failureStatus: options.failureStatus ?? "failed",
    resumed: false,
    claimToken: null,
    replayedSteps: [],
    startStepKey: options.steps[0]?.key,
  });
}

export async function continueRoutineRun<TOutputs extends Record<string, unknown>>(
  options: ResumeRoutineOptions<TOutputs>,
): Promise<RoutineExecutionResult<TOutputs>> {
  if (options.run.status === "waiting_for_approval") {
    throw new RoutineExecutionError("APPROVAL_REQUIRED", options.run.id);
  }
  if (["completed", "partial", "failed", "cancelled"].includes(options.run.status)) {
    throw new RoutineExecutionError("CANNOT_RESUME", options.run.id);
  }
  if (options.run.status === "running") {
    throw new RoutineExecutionError("RUN_ALREADY_RESUMING", options.run.id);
  }
  if (requiresRoutineOperatorReview(options.run)) {
    throw new RoutineExecutionError("RUN_REQUIRES_REVIEW", options.run.id);
  }
  if (options.run.status !== "blocked") {
    throw new RoutineExecutionError("CANNOT_RESUME", options.run.id);
  }

  const replayedSteps = await options.store.listStepRuns(options.run.id, options.userId);
  const claimed = await options.store.markRunRunning(options.run.id, options.userId, options.run.status);
  if (claimed === false) {
    throw new RoutineExecutionError("RUN_ALREADY_RESUMING", options.run.id);
  }

  return runRoutineSteps({
    store: options.store,
    userId: options.userId,
    runId: options.run.id,
    steps: options.steps,
    buildRunOutput: options.buildRunOutput,
    actualCostUsd: options.actualCostUsd ?? 0,
    failureStatus: options.failureStatus ?? "failed",
    resumed: true,
    claimToken: null,
    replayedSteps,
    startStepKey: options.steps[0]?.key,
  });
}

export async function resumeRoutine<TOutputs extends Record<string, unknown>>(
  options: ResumeRoutineOptions<TOutputs>,
): Promise<RoutineExecutionResult<TOutputs>> {
  if (options.run.status !== "waiting_for_approval") {
    throw new RoutineExecutionError("RUN_NOT_WAITING_FOR_APPROVAL", options.run.id);
  }
  if (!options.run.paused_step_key || !options.run.approval_id) {
    throw new RoutineExecutionError("RUN_PAUSE_METADATA_MISSING", options.run.id);
  }
  if (options.preclaimed && !options.run.resume_claim_token) {
    throw new RoutineExecutionError("RUN_RESUME_CLAIM_MISSING", options.run.id);
  }

  const replayedSteps = await options.store.listStepRuns(options.run.id, options.userId);
  if (!options.preclaimed) {
    const claimed = await options.store.markRunRunning(options.run.id, options.userId);
    if (claimed === false) {
      throw new RoutineExecutionError("RUN_ALREADY_RESUMING", options.run.id);
    }
  }
  if (options.preclaimed) {
    await options.store.renewRunClaim(options.run.id, options.userId);
  }

  return runRoutineSteps({
    store: options.store,
    userId: options.userId,
    runId: options.run.id,
    steps: options.steps,
    buildRunOutput: options.buildRunOutput,
    actualCostUsd: options.actualCostUsd ?? 0,
    failureStatus: options.failureStatus ?? "failed",
    resumed: true,
    claimToken: options.preclaimed ? options.run.resume_claim_token ?? null : null,
    replayedSteps,
    startStepKey: options.run.paused_step_key,
  });
}

async function runRoutineSteps<TOutputs extends Record<string, unknown>>(options: {
  store: RoutineExecutionStore;
  userId: string;
  runId: string;
  steps: readonly RoutineStep<TOutputs>[];
  buildRunOutput: (outputs: Partial<TOutputs>) => Json;
  actualCostUsd: number;
  failureStatus: "blocked" | "failed";
  resumed: boolean;
  claimToken: string | null;
  replayedSteps: RoutineStepRunSnapshot[];
  startStepKey: string | undefined;
}): Promise<RoutineExecutionResult<TOutputs>> {
  const startIndex = options.startStepKey
    ? options.steps.findIndex((step) => step.key === options.startStepKey)
    : 0;
  if (startIndex < 0) {
    await options.store.failRun({
      runId: options.runId,
      userId: options.userId,
      status: options.failureStatus,
      error: "PAUSED_STEP_NOT_FOUND",
    });
    throw new RoutineExecutionError("PAUSED_STEP_NOT_FOUND", options.runId);
  }

  const outputs: Partial<TOutputs> = {};
  const stepStatuses: StepStatus[] = [];
  let ordinal = 0;

  for (const row of options.replayedSteps) {
    ordinal = Math.max(ordinal, row.ordinal);
    const stepExists = options.steps.some((step) => step.key === row.step_key);
    if (stepExists && row.status === "succeeded") {
      outputs[row.step_key as keyof TOutputs] = row.output_snapshot as TOutputs[keyof TOutputs];
      stepStatuses.push("succeeded");
    }
  }

  for (let i = startIndex; i < options.steps.length; i += 1) {
    const step = options.steps[i];
    const context: RoutineStepContext<TOutputs> = {
      runId: options.runId,
      userId: options.userId,
      outputs,
      resumed: options.resumed,
      claimToken: options.claimToken,
      assertClaimActive: async () => {
        if (!options.claimToken) return;
        await options.store.renewRunClaim(options.runId, options.userId);
      },
    };
    if (Object.prototype.hasOwnProperty.call(outputs, step.key)) continue;

    const runningStep = options.replayedSteps.find(
      (row) => row.step_key === step.key && row.status === "running",
    );
    const inputSnapshot = step.input?.(context) ?? {};
    let stepRun = runningStep ? { id: runningStep.id, ordinal: runningStep.ordinal } : null;

    try {
      await context.assertClaimActive();
      if (!stepRun) {
        ordinal += 1;
        stepRun = await options.store.startStep({
          runId: options.runId,
          userId: options.userId,
          stepKey: step.key,
          ordinal,
          inputSnapshot,
        });
      }

      const result = await runStepWithClaimHeartbeat(
        options.store,
        options.runId,
        options.userId,
        options.claimToken,
        () => step.run(context),
      );
      if (isPauseSignal(result)) {
        await options.store.markRunWaitingForApproval({
          runId: options.runId,
          userId: options.userId,
          pausedStepKey: step.key,
          approvalId: result.approvalId,
          idempotencyKey: result.idempotencyKey ?? null,
        });
        return {
          status: "waiting_for_approval",
          runId: options.runId,
          pausedStepKey: step.key,
          approvalId: result.approvalId,
          idempotencyKey: result.idempotencyKey ?? null,
          outputs,
        };
      }

      outputs[step.key as keyof TOutputs] = result as TOutputs[keyof TOutputs];
      await options.store.completeStep({
        stepRunId: stepRun.id,
        runId: options.runId,
        userId: options.userId,
        outputSnapshot: toJson(result),
      });
      stepStatuses.push("succeeded");
    } catch (err) {
      const code = normalizeRoutineError(err);
      let stepRecordFailed = false;
      if (stepRun) {
        try {
          await options.store.failStep({
            stepRunId: stepRun.id,
            runId: options.runId,
            userId: options.userId,
            error: code,
          });
        } catch {
          stepRecordFailed = true;
        }
      }
      try {
        await options.store.failRun({
          runId: options.runId,
          userId: options.userId,
          status: options.failureStatus,
          error: code,
        });
      } catch (releaseError) {
        throw new RoutineExecutionError(normalizeRoutineError(releaseError), options.runId);
      }
      throw new RoutineExecutionError(
        stepRecordFailed ? "STEP_FAIL_RECORD_FAILED" : code,
        options.runId,
      );
    }
  }

  const output = options.buildRunOutput(outputs);
  const status = deriveRunOutcome(stepStatuses) as Exclude<RunStatus, "waiting_for_approval">;
  await options.store.completeRun({
    runId: options.runId,
    userId: options.userId,
    status,
    output,
    actualCostUsd: options.actualCostUsd,
  });

  return { status, runId: options.runId, output, outputs };
}

function toJson(value: unknown): Json {
  return (value ?? null) as Json;
}

const CLAIM_HEARTBEAT_INTERVAL_MS = 60_000;

async function runStepWithClaimHeartbeat<T>(
  store: RoutineExecutionStore,
  runId: string,
  userId: string,
  claimToken: string | null,
  run: () => Promise<T>,
): Promise<T> {
  if (!claimToken) return run();

  let renewalInFlight = false;
  let renewalError: Error | null = null;
  const renew = async () => {
    if (renewalInFlight || renewalError) return;
    renewalInFlight = true;
    try {
      await store.renewRunClaim(runId, userId);
    } catch {
      renewalError = new Error("RUN_RESUME_CLAIM_LOST");
    } finally {
      renewalInFlight = false;
    }
  };

  await store.renewRunClaim(runId, userId);
  const heartbeat = setInterval(() => {
    void renew();
  }, CLAIM_HEARTBEAT_INTERVAL_MS);
  try {
    const result = await run();
    if (renewalError) throw renewalError;
    await store.renewRunClaim(runId, userId);
    return result;
  } finally {
    clearInterval(heartbeat);
  }
}

function isStepStartResult(value: Json): value is { id: string; ordinal: number } {
  return !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.id === "string" &&
    typeof value.ordinal === "number" &&
    Number.isInteger(value.ordinal);
}

/**
 * Persist and report stable error codes only. Provider/DB messages can contain
 * private content; arbitrary messages must never enter run snapshots or Sentry.
 */
export function normalizeRoutineError(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /^[A-Z][A-Z0-9_]{2,63}$/.test(message) ? message : "ROUTINE_STEP_FAILED";
}
