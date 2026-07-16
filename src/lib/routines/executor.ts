import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/database.types";
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
  stepRunId: string;
  outputSnapshot: Json;
};

type FailStepInput = {
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

export type RoutineExecutionStore = {
  createRun(input: CreateRunInput): Promise<{ id: string }>;
  listStepRuns(runId: string, userId: string): Promise<RoutineStepRunSnapshot[]>;
  startStep(input: StartStepInput): Promise<{ id: string; ordinal: number }>;
  completeStep(input: CompleteStepInput): Promise<void>;
  failStep(input: FailStepInput): Promise<void>;
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
): RoutineExecutionStore {
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

    async markRunRunning(runId, userId, expectedStatus = "waiting_for_approval") {
      const { data, error } = await supabase
        .from("routine_runs")
        .update({ status: "running", error: null })
        .eq("user_id", userId)
        .eq("id", runId)
        .eq("status", expectedStatus)
        .select("id")
        .maybeSingle();
      if (error) throw new Error("RUN_RESUME_FAILED");
      return !!data;
    },

    async markRunWaitingForApproval(input) {
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

  const replayedSteps = await options.store.listStepRuns(options.run.id, options.userId);
  const claimed = await options.store.markRunRunning(options.run.id, options.userId);
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
    };
    if (Object.prototype.hasOwnProperty.call(outputs, step.key)) continue;

    const runningStep = options.replayedSteps.find(
      (row) => row.step_key === step.key && row.status === "running",
    );
    const inputSnapshot = step.input?.(context) ?? {};
    let stepRun = runningStep ? { id: runningStep.id, ordinal: runningStep.ordinal } : null;

    try {
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

      const result = await step.run(context);
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
        outputSnapshot: toJson(result),
      });
      stepStatuses.push("succeeded");
    } catch (err) {
      const message = err instanceof Error ? err.message : "step failed";
      if (stepRun) await options.store.failStep({ stepRunId: stepRun.id, error: message });
      await options.store.failRun({
        runId: options.runId,
        userId: options.userId,
        status: options.failureStatus,
        error: message,
      });
      throw new RoutineExecutionError(message, options.runId);
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
