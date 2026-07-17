import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/database.types";
import type {
  RoutineResumeClaims,
  RoutineResumeFailure,
} from "@/lib/routines/resumeClaims";
import { captureRouteError } from "@/lib/observability/captureRouteError";
import { deriveRunOutcome, type RunStatus, type StepStatus } from "@/lib/routines/runState";

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
  idempotencyKey: string | null;
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
  runId: string;
  userId: string;
  stepRunId: string;
  outputSnapshot: Json;
};

type FailStepInput = {
  runId: string;
  userId: string;
  stepRunId: string;
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

type StartedRoutineStep = {
  id: string;
  ordinal: number;
  status: "running" | "succeeded";
  outputSnapshot: Json | null;
};

export type RoutineExecutionStore = {
  resumeMode?: "claimed";
  createRun(input: CreateRunInput): Promise<{ id: string }>;
  listStepRuns(runId: string, userId: string): Promise<RoutineStepRunSnapshot[]>;
  startStep(input: StartStepInput): Promise<StartedRoutineStep>;
  completeStep(input: CompleteStepInput): Promise<void>;
  failStep(input: FailStepInput): Promise<void>;
  renewRunClaim?(runId: string, userId: string): Promise<void>;
  markRunRunning(runId: string, userId: string): Promise<void>;
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

export function routineResumeIdempotencyKey(runId: string, stepKey: string): string {
  return `routine-resume:${runId}:${stepKey}`;
}

export function safeRoutineErrorCode(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error ?? "");
  return /^[A-Z][A-Z0-9_:-]{0,127}$/.test(value)
    ? value
    : "ROUTINE_RESUME_FAILED";
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
  resumeClaim?: {
    claimToken: string;
    claims: RoutineResumeClaims;
    leaseSeconds?: number;
  },
): RoutineExecutionStore {
  return {
    ...(resumeClaim ? { resumeMode: "claimed" as const } : {}),
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
        const result = await resumeClaim.claims.startStep({
          userId: input.userId,
          runId: input.runId,
          claimToken: resumeClaim.claimToken,
          stepKey: input.stepKey,
          ordinal: input.ordinal,
          inputSnapshot: input.inputSnapshot,
        });
        if (!result.ok) throw resumeMutationError(result, "STEP_START_FAILED");
        return {
          id: result.value.step.id,
          ordinal: result.value.step.ordinal,
          status: result.value.alreadySucceeded ? "succeeded" : "running",
          outputSnapshot: result.value.step.outputSnapshot,
        };
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
      return {
        ...data,
        status: "running",
        outputSnapshot: null,
      };
    },

    async completeStep(input) {
      if (resumeClaim) {
        const result = await resumeClaim.claims.completeStep({
          userId: input.userId,
          runId: input.runId,
          claimToken: resumeClaim.claimToken,
          stepRunId: input.stepRunId,
          outputSnapshot: input.outputSnapshot,
        });
        if (!result.ok) throw resumeMutationError(result, "STEP_COMPLETE_FAILED");
        return;
      }

      const { error } = await supabase
        .from("routine_step_runs")
        .update({
          status: "succeeded",
          output_snapshot: input.outputSnapshot,
          completed_at: new Date().toISOString(),
        })
        .eq("id", input.stepRunId);
      if (error) throw new Error("STEP_COMPLETE_FAILED");
    },

    async failStep(input) {
      if (resumeClaim) {
        const result = await resumeClaim.claims.failStep({
          userId: input.userId,
          runId: input.runId,
          claimToken: resumeClaim.claimToken,
          stepRunId: input.stepRunId,
          errorCode: safeRoutineErrorCode(input.error),
        });
        if (!result.ok) throw resumeMutationError(result, "STEP_FAIL_RECORD_FAILED");
        return;
      }

      const { error } = await supabase
        .from("routine_step_runs")
        .update({
          status: "failed",
          error: input.error,
          completed_at: new Date().toISOString(),
        })
        .eq("id", input.stepRunId);
      if (error) throw new Error("STEP_FAIL_RECORD_FAILED");
    },

    async renewRunClaim(runId, userId) {
      if (!resumeClaim) return;
      const result = await resumeClaim.claims.renew({
        userId,
        runId,
        claimToken: resumeClaim.claimToken,
        leaseSeconds: resumeClaim.leaseSeconds,
      });
      if (!result.ok) throw resumeMutationError(result, "RUN_RESUME_RENEW_FAILED");
    },

    async markRunRunning(runId, userId) {
      if (resumeClaim) return;
      const { error } = await supabase
        .from("routine_runs")
        .update({ status: "running", error: null })
        .eq("user_id", userId)
        .eq("id", runId);
      if (error) throw new Error("RUN_RESUME_FAILED");
    },

    async markRunWaitingForApproval(input) {
      if (resumeClaim) {
        const result = await resumeClaim.claims.repause({
          userId: input.userId,
          runId: input.runId,
          claimToken: resumeClaim.claimToken,
          stepKey: input.pausedStepKey,
          approvalId: input.approvalId,
          idempotencyKey: input.idempotencyKey
            ?? routineResumeIdempotencyKey(input.runId, input.pausedStepKey),
        });
        if (!result.ok) throw resumeMutationError(result, "RUN_PAUSE_FAILED");
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
      if (error) throw new Error("RUN_PAUSE_FAILED");
    },

    async completeRun(input) {
      if (resumeClaim) {
        if (input.status !== "completed" && input.status !== "partial") {
          throw new Error("RUN_RESUME_INVALID_COMPLETION");
        }
        const result = await resumeClaim.claims.complete({
          userId: input.userId,
          runId: input.runId,
          claimToken: resumeClaim.claimToken,
          status: input.status,
          output: input.output,
          actualCostUsd: input.actualCostUsd,
        });
        if (!result.ok) throw resumeMutationError(result, "RUN_COMPLETE_FAILED");
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
      if (error) throw new Error("RUN_COMPLETE_FAILED");
    },

    async failRun(input) {
      if (resumeClaim) {
        const result = await resumeClaim.claims.release({
          userId: input.userId,
          runId: input.runId,
          claimToken: resumeClaim.claimToken,
          errorCode: safeRoutineErrorCode(input.error),
        });
        if (!result.ok) throw resumeMutationError(result, "RUN_RELEASE_FAILED");
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
    idempotencyKey: null,
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

  const replayedSteps = await options.store.listStepRuns(options.run.id, options.userId);
  await options.store.markRunRunning(options.run.id, options.userId);

  return runRoutineSteps({
    store: options.store,
    userId: options.userId,
    runId: options.run.id,
    steps: options.steps,
    buildRunOutput: options.buildRunOutput,
    actualCostUsd: options.actualCostUsd ?? 0,
    failureStatus: options.failureStatus ?? "failed",
    resumed: true,
    idempotencyKey: options.run.idempotency_key,
    replayedSteps,
    startStepKey: options.steps[0]?.key,
  });
}

export async function resumeRoutine<TOutputs extends Record<string, unknown>>(
  options: ResumeRoutineOptions<TOutputs>,
): Promise<RoutineExecutionResult<TOutputs>> {
  const claimed = options.store.resumeMode === "claimed";
  if (
    (!claimed && options.run.status !== "waiting_for_approval")
    || (claimed && options.run.status !== "running")
  ) {
    throw new RoutineExecutionError("RUN_NOT_WAITING_FOR_APPROVAL", options.run.id);
  }
  if (!options.run.paused_step_key || !options.run.approval_id) {
    throw new RoutineExecutionError("RUN_PAUSE_METADATA_MISSING", options.run.id);
  }
  if (claimed && !options.run.idempotency_key) {
    throw new RoutineExecutionError("RUN_PAUSE_METADATA_MISSING", options.run.id);
  }

  const replayedSteps = await options.store.listStepRuns(options.run.id, options.userId);
  if (!claimed) await options.store.markRunRunning(options.run.id, options.userId);

  return runRoutineSteps({
    store: options.store,
    userId: options.userId,
    runId: options.run.id,
    steps: options.steps,
    buildRunOutput: options.buildRunOutput,
    actualCostUsd: options.actualCostUsd ?? 0,
    failureStatus: options.failureStatus ?? "failed",
    resumed: true,
    idempotencyKey: options.run.idempotency_key,
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
  idempotencyKey: string | null;
  replayedSteps: RoutineStepRunSnapshot[];
  startStepKey: string | undefined;
}): Promise<RoutineExecutionResult<TOutputs>> {
  const startIndex = options.startStepKey
    ? options.steps.findIndex((step) => step.key === options.startStepKey)
    : 0;
  if (startIndex < 0) {
    await recordRunFailure(options.store, {
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
    const stepIdempotencyKey = options.resumed
      && step.key === options.startStepKey
      && options.idempotencyKey
      ? options.idempotencyKey
      : routineResumeIdempotencyKey(options.runId, step.key);
    const context: RoutineStepContext<TOutputs> = {
      runId: options.runId,
      userId: options.userId,
      outputs,
      resumed: options.resumed,
      idempotencyKey: stepIdempotencyKey,
    };
    if (Object.prototype.hasOwnProperty.call(outputs, step.key)) continue;

    const runningStep = options.replayedSteps.find(
      (row) => row.step_key === step.key && row.status === "running",
    );
    const inputSnapshot = step.input?.(context) ?? {};
    let stepRun: StartedRoutineStep | null = runningStep
      ? {
          id: runningStep.id,
          ordinal: runningStep.ordinal,
          status: "running" as const,
          outputSnapshot: runningStep.output_snapshot,
        }
      : null;

    try {
      if (options.store.renewRunClaim) {
        await options.store.renewRunClaim(options.runId, options.userId);
      }

      if (!stepRun || options.store.resumeMode === "claimed") {
        const stepOrdinal = stepRun?.ordinal ?? ordinal + 1;
        ordinal = Math.max(ordinal, stepOrdinal);
        stepRun = await options.store.startStep({
          runId: options.runId,
          userId: options.userId,
          stepKey: step.key,
          ordinal: stepOrdinal,
          inputSnapshot,
        });
      }

      if (stepRun.status === "succeeded") {
        outputs[step.key as keyof TOutputs] =
          stepRun.outputSnapshot as TOutputs[keyof TOutputs];
        stepStatuses.push("succeeded");
        continue;
      }

      const result = await step.run(context);
      if (options.store.renewRunClaim) {
        await options.store.renewRunClaim(options.runId, options.userId);
      }

      if (isPauseSignal(result)) {
        const idempotencyKey = result.idempotencyKey
          ?? context.idempotencyKey;
        await options.store.markRunWaitingForApproval({
          runId: options.runId,
          userId: options.userId,
          pausedStepKey: step.key,
          approvalId: result.approvalId,
          idempotencyKey,
        });
        return {
          status: "waiting_for_approval",
          runId: options.runId,
          pausedStepKey: step.key,
          approvalId: result.approvalId,
          idempotencyKey,
          outputs,
        };
      }

      outputs[step.key as keyof TOutputs] = result as TOutputs[keyof TOutputs];
      await options.store.completeStep({
        runId: options.runId,
        userId: options.userId,
        stepRunId: stepRun.id,
        outputSnapshot: toJson(result),
      });
      stepStatuses.push("succeeded");
    } catch (err) {
      const errorCode = safeRoutineErrorCode(err);
      if (stepRun) {
        await recordStepFailure(options.store, {
          runId: options.runId,
          userId: options.userId,
          stepRunId: stepRun.id,
          error: errorCode,
        });
      }
      await recordRunFailure(options.store, {
        runId: options.runId,
        userId: options.userId,
        status: options.failureStatus,
        error: errorCode,
      });
      throw new RoutineExecutionError(errorCode, options.runId);
    }
  }

  try {
    const output = options.buildRunOutput(outputs);
    const status = deriveRunOutcome(stepStatuses) as Exclude<RunStatus, "waiting_for_approval">;
    if (options.store.renewRunClaim) {
      await options.store.renewRunClaim(options.runId, options.userId);
    }
    await options.store.completeRun({
      runId: options.runId,
      userId: options.userId,
      status,
      output,
      actualCostUsd: options.actualCostUsd,
    });

    return { status, runId: options.runId, output, outputs };
  } catch (err) {
    const errorCode = safeRoutineErrorCode(err);
    await recordRunFailure(options.store, {
      runId: options.runId,
      userId: options.userId,
      status: options.failureStatus,
      error: errorCode,
    });
    throw new RoutineExecutionError(errorCode, options.runId);
  }
}

async function recordStepFailure(
  store: RoutineExecutionStore,
  input: FailStepInput,
): Promise<void> {
  try {
    await store.failStep(input);
  } catch (error) {
    captureRoutinePersistenceFailure(error, "record_step_failure", input.runId, store);
  }
}

async function recordRunFailure(
  store: RoutineExecutionStore,
  input: FailRunInput,
): Promise<void> {
  try {
    await store.failRun(input);
  } catch (error) {
    captureRoutinePersistenceFailure(error, "record_run_failure", input.runId, store);
  }
}

function captureRoutinePersistenceFailure(
  error: unknown,
  operation: "record_step_failure" | "record_run_failure",
  runId: string,
  store: RoutineExecutionStore,
): void {
  captureRouteError(error, {
    route: "routine.executor",
    operation,
    area: "routines",
    status: 500,
    code: safeRoutineErrorCode(error),
    tags: {
      runId,
      claimedResume: store.resumeMode === "claimed",
    },
  });
}

function toJson(value: unknown): Json {
  return (value ?? null) as Json;
}

function resumeMutationError(
  failure: RoutineResumeFailure,
  fallback: string,
): Error {
  const codes: Partial<Record<RoutineResumeFailure["code"], string>> = {
    SERVICE_UNAVAILABLE: "RUN_RESUME_SERVICE_UNAVAILABLE",
    CLAIM_LOST: "RUN_RESUME_CLAIM_LOST",
    TERMINAL: "RUN_ALREADY_TERMINAL",
    PAUSE_METADATA_MISSING: "RUN_PAUSE_METADATA_MISSING",
    APPROVAL_NOT_APPROVED: "APPROVAL_NOT_APPROVED",
    APPROVAL_EXPIRED: "APPROVAL_EXPIRED",
    STEP_UP_STALE: "APPROVAL_STEP_UP_STALE",
    APPROVAL_NOT_ACTIONABLE: "APPROVAL_NOT_ACTIONABLE",
    STEPS_INCOMPLETE: "RUN_STEPS_INCOMPLETE",
    STEP_NOT_FOUND: "RUN_STEP_NOT_FOUND",
    STEP_CONFLICT: "RUN_STEP_CONFLICT",
    RECONCILIATION_FAILED: "RUN_COMPLETE_RECONCILIATION_FAILED",
  };
  return new Error(codes[failure.code] ?? fallback);
}
