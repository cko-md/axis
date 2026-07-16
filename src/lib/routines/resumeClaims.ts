import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/database.types";

type RpcResponse = {
  data: unknown;
  error: unknown;
};

type UntypedRpcClient = {
  rpc(name: string, args: Record<string, unknown>): Promise<RpcResponse>;
};

export type RoutineResumeFailureCode =
  | "SERVICE_UNAVAILABLE"
  | "RPC_FAILED"
  | "INVALID_RESPONSE"
  | "NOT_FOUND"
  | "BUSY"
  | "TERMINAL"
  | "NOT_RESUMABLE"
  | "PAUSE_METADATA_MISSING"
  | "APPROVAL_NOT_APPROVED"
  | "APPROVAL_NOT_ACTIONABLE"
  | "APPROVAL_EXPIRED"
  | "STEP_UP_STALE"
  | "CLAIM_LOST"
  | "REPLACEMENT_APPROVAL_NOT_FOUND"
  | "REPLACEMENT_APPROVAL_NOT_PENDING"
  | "STEPS_INCOMPLETE"
  | "STEP_NOT_FOUND"
  | "STEP_CONFLICT"
  | "RECONCILIATION_FAILED";

export type RoutineResumeFailure = {
  ok: false;
  code: RoutineResumeFailureCode;
  currentStatus?: string;
  claimExpiresAt?: string;
};

export type RoutineResumeResult<T> = { ok: true; value: T } | RoutineResumeFailure;

export type ClaimedRoutineResume = {
  kind: "claimed";
  runId: string;
  status: "running";
  routineKey: string;
  routineVersion: number;
  inputSnapshot: Json;
  stepKey: string;
  approvalId: string;
  idempotencyKey: string;
  resumeAttempt: number;
  claimExpiresAt: string;
  reused: boolean;
};

export type TerminalRoutineResume = {
  kind: "terminal";
  runId: string;
  status: string;
  output: Json | null;
  actualCostUsd: number | null;
  completedAt: string | null;
};

export type RoutineResumeClaimResult = RoutineResumeResult<
  ClaimedRoutineResume | TerminalRoutineResume
>;

export type ClaimedRoutineStep = {
  id: string;
  stepKey: string;
  ordinal: number;
  status: string;
  outputSnapshot: Json | null;
};

export type RoutineResumeClaims = {
  claim(input: {
    userId: string;
    runId: string;
    claimToken: string;
    leaseSeconds?: number;
  }): Promise<RoutineResumeClaimResult>;
  renew(input: {
    userId: string;
    runId: string;
    claimToken: string;
    leaseSeconds?: number;
  }): Promise<RoutineResumeResult<{ claimExpiresAt: string; resumeAttempt: number }>>;
  release(input: {
    userId: string;
    runId: string;
    claimToken: string;
    errorCode?: string | null;
  }): Promise<RoutineResumeResult<{
    status: "waiting_for_approval";
    stepKey: string;
    approvalId: string;
    idempotencyKey: string;
    resumeAttempt: number;
  }>>;
  repause(input: {
    userId: string;
    runId: string;
    claimToken: string;
    stepKey: string;
    approvalId: string;
    idempotencyKey: string;
  }): Promise<RoutineResumeResult<{
    status: "waiting_for_approval";
    stepKey: string;
    approvalId: string;
    idempotencyKey: string;
    resumeAttempt: number;
  }>>;
  complete(input: {
    userId: string;
    runId: string;
    claimToken: string;
    status: "completed" | "partial";
    output: Json;
    actualCostUsd: number;
  }): Promise<RoutineResumeResult<{
    status: "completed" | "partial";
    output: Json;
    actualCostUsd: number;
    completedAt: string;
    approvalId: string;
    reused: boolean;
  }>>;
  startStep(input: {
    userId: string;
    runId: string;
    claimToken: string;
    stepKey: string;
    ordinal: number;
    inputSnapshot: Json;
  }): Promise<RoutineResumeResult<{
    step: ClaimedRoutineStep;
    reused: boolean;
    alreadySucceeded: boolean;
  }>>;
  completeStep(input: {
    userId: string;
    runId: string;
    claimToken: string;
    stepRunId: string;
    outputSnapshot: Json;
  }): Promise<RoutineResumeResult<{ step: ClaimedRoutineStep; reused: boolean }>>;
  failStep(input: {
    userId: string;
    runId: string;
    claimToken: string;
    stepRunId: string;
    errorCode: string;
  }): Promise<RoutineResumeResult<{ step: ClaimedRoutineStep; reused: boolean }>>;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function json(value: unknown): Json {
  return (value ?? null) as Json;
}

function failure(result: Record<string, unknown>): RoutineResumeFailure | null {
  const currentStatus = string(result.currentStatus) ?? undefined;
  const claimExpiresAt = string(result.claimExpiresAt) ?? undefined;
  const fields = {
    ...(currentStatus ? { currentStatus } : {}),
    ...(claimExpiresAt ? { claimExpiresAt } : {}),
  };
  const outcomes: Record<string, RoutineResumeFailureCode> = {
    not_found: "NOT_FOUND",
    busy: "BUSY",
    terminal: "TERMINAL",
    not_resumable: "NOT_RESUMABLE",
    pause_metadata_missing: "PAUSE_METADATA_MISSING",
    approval_not_approved: "APPROVAL_NOT_APPROVED",
    approval_not_actionable: "APPROVAL_NOT_ACTIONABLE",
    approval_expired: "APPROVAL_EXPIRED",
    step_up_stale: "STEP_UP_STALE",
    claim_lost: "CLAIM_LOST",
    replacement_approval_not_found: "REPLACEMENT_APPROVAL_NOT_FOUND",
    replacement_approval_not_pending: "REPLACEMENT_APPROVAL_NOT_PENDING",
    steps_incomplete: "STEPS_INCOMPLETE",
    step_not_found: "STEP_NOT_FOUND",
    step_conflict: "STEP_CONFLICT",
  };
  const code = outcomes[String(result.outcome)];
  return code ? { ok: false, code, ...fields } : null;
}

function step(value: unknown): ClaimedRoutineStep | null {
  const row = record(value);
  const id = string(row?.id);
  const stepKey = string(row?.step_key);
  const ordinal = number(row?.ordinal);
  const status = string(row?.status);
  if (!row || !id || !stepKey || ordinal === null || !status) return null;
  return {
    id,
    stepKey,
    ordinal,
    status,
    outputSnapshot: json(row.output_snapshot),
  };
}

function invalid(): RoutineResumeFailure {
  return { ok: false, code: "INVALID_RESPONSE" };
}

export function createRoutineResumeClaims(
  client: SupabaseClient | null = createAdminClient(),
): RoutineResumeClaims {
  // Generated database types intentionally lag this expand-phase migration.
  // Keep the escape hatch constrained to the RPC boundary and strictly parse
  // every response before returning it to the executor.
  const rpcClient = client as unknown as UntypedRpcClient | null;

  async function call(
    name: string,
    args: Record<string, unknown>,
    options: { retryAmbiguous?: boolean } = {},
  ) {
    if (!rpcClient) {
      return { ok: false as const, code: "SERVICE_UNAVAILABLE" as const };
    }
    const attempts = options.retryAmbiguous ? 2 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const { data, error } = await rpcClient.rpc(name, args);
        if (error) continue;
        const result = record(data);
        return result
          ? { ok: true as const, result }
          : { ok: false as const, code: "INVALID_RESPONSE" as const };
      } catch {
        // A transport failure may happen after the transaction committed.
        // Only explicitly idempotent calls opt into a same-token retry.
      }
    }
    return { ok: false as const, code: "RPC_FAILED" as const };
  }

  async function reconcileCompletedRun(input: {
    userId: string;
    runId: string;
  }): Promise<RoutineResumeResult<{
    status: "completed" | "partial";
    output: Json;
    actualCostUsd: number;
    completedAt: string;
    approvalId: string;
    reused: true;
  }> | null> {
    if (!client) return { ok: false, code: "SERVICE_UNAVAILABLE" };
    try {
      const { data, error } = await client
        .from("routine_runs")
        .select("id, status, output, actual_cost_usd, completed_at, approval_id")
        .eq("user_id", input.userId)
        .eq("id", input.runId)
        .maybeSingle();
      if (error) return { ok: false, code: "RECONCILIATION_FAILED" };
      if (!data || (data.status !== "completed" && data.status !== "partial")) return null;
      const actualCostUsd = number(data.actual_cost_usd);
      const completedAt = string(data.completed_at);
      const approvalId = string(data.approval_id);
      if (actualCostUsd === null || !completedAt || !approvalId) {
        return { ok: false, code: "RECONCILIATION_FAILED" };
      }
      return {
        ok: true,
        value: {
          status: data.status,
          output: json(data.output),
          actualCostUsd,
          completedAt,
          approvalId,
          reused: true,
        },
      };
    } catch {
      return { ok: false, code: "RECONCILIATION_FAILED" };
    }
  }

  return {
    async claim(input) {
      const called = await call(
        "claim_routine_resume",
        {
          p_user_id: input.userId,
          p_run_id: input.runId,
          p_claim_token: input.claimToken,
          p_lease_seconds: input.leaseSeconds ?? 300,
        },
        { retryAmbiguous: true },
      );
      if (!called.ok) return called;
      const { result } = called;
      if (result.outcome === "terminal") {
        const runId = string(result.runId);
        const status = string(result.status);
        if (!runId || !status) return invalid();
        return {
          ok: true,
          value: {
            kind: "terminal",
            runId,
            status,
            output: json(result.output),
            actualCostUsd: number(result.actualCostUsd),
            completedAt: string(result.completedAt),
          },
        };
      }
      if (result.outcome === "claimed") {
        const runId = string(result.runId);
        const status = string(result.status);
        const routineKey = string(result.routineKey);
        const routineVersion = number(result.routineVersion);
        const stepKey = string(result.stepKey);
        const approvalId = string(result.approvalId);
        const idempotencyKey = string(result.idempotencyKey);
        const resumeAttempt = number(result.resumeAttempt);
        const claimExpiresAt = string(result.claimExpiresAt);
        if (
          !runId
          || status !== "running"
          || !routineKey
          || routineVersion === null
          || !stepKey
          || !approvalId
          || !idempotencyKey
          || resumeAttempt === null
          || !claimExpiresAt
          || typeof result.reused !== "boolean"
        ) {
          return invalid();
        }
        return {
          ok: true,
          value: {
            kind: "claimed",
            runId,
            status,
            routineKey,
            routineVersion,
            inputSnapshot: json(result.inputSnapshot),
            stepKey,
            approvalId,
            idempotencyKey,
            resumeAttempt,
            claimExpiresAt,
            reused: result.reused,
          },
        };
      }
      return failure(result) ?? invalid();
    },

    async renew(input) {
      const called = await call("renew_routine_resume_claim", {
        p_user_id: input.userId,
        p_run_id: input.runId,
        p_claim_token: input.claimToken,
        p_lease_seconds: input.leaseSeconds ?? 300,
      });
      if (!called.ok) return called;
      if (called.result.outcome === "renewed") {
        const claimExpiresAt = string(called.result.claimExpiresAt);
        const resumeAttempt = number(called.result.resumeAttempt);
        return claimExpiresAt && resumeAttempt !== null
          ? { ok: true, value: { claimExpiresAt, resumeAttempt } }
          : invalid();
      }
      return failure(called.result) ?? invalid();
    },

    async release(input) {
      const called = await call("release_routine_resume_claim", {
        p_user_id: input.userId,
        p_run_id: input.runId,
        p_claim_token: input.claimToken,
        p_error_code: input.errorCode ?? null,
      });
      if (!called.ok) return called;
      if (called.result.outcome === "released") {
        const stepKey = string(called.result.stepKey);
        const approvalId = string(called.result.approvalId);
        const idempotencyKey = string(called.result.idempotencyKey);
        const resumeAttempt = number(called.result.resumeAttempt);
        return stepKey && approvalId && idempotencyKey && resumeAttempt !== null
          ? {
              ok: true,
              value: {
                status: "waiting_for_approval",
                stepKey,
                approvalId,
                idempotencyKey,
                resumeAttempt,
              },
            }
          : invalid();
      }
      return failure(called.result) ?? invalid();
    },

    async repause(input) {
      const called = await call("repause_routine_resume", {
        p_user_id: input.userId,
        p_run_id: input.runId,
        p_claim_token: input.claimToken,
        p_step_key: input.stepKey,
        p_approval_id: input.approvalId,
        p_idempotency_key: input.idempotencyKey,
      });
      if (!called.ok) return called;
      if (called.result.outcome === "repaused") {
        const stepKey = string(called.result.stepKey);
        const approvalId = string(called.result.approvalId);
        const idempotencyKey = string(called.result.idempotencyKey);
        const resumeAttempt = number(called.result.resumeAttempt);
        return stepKey && approvalId && idempotencyKey && resumeAttempt !== null
          ? {
              ok: true,
              value: {
                status: "waiting_for_approval",
                stepKey,
                approvalId,
                idempotencyKey,
                resumeAttempt,
              },
            }
          : invalid();
      }
      return failure(called.result) ?? invalid();
    },

    async complete(input) {
      const called = await call("complete_routine_resume", {
        p_user_id: input.userId,
        p_run_id: input.runId,
        p_claim_token: input.claimToken,
        p_status: input.status,
        p_output: input.output,
        p_actual_cost_usd: input.actualCostUsd,
      });
      if (!called.ok) {
        if (called.code === "RPC_FAILED" || called.code === "INVALID_RESPONSE") {
          return await reconcileCompletedRun(input) ?? called;
        }
        return called;
      }
      if (called.result.outcome === "completed") {
        const status = string(called.result.status);
        const actualCostUsd = number(called.result.actualCostUsd);
        const completedAt = string(called.result.completedAt);
        const approvalId = string(called.result.approvalId);
        if (
          (status !== "completed" && status !== "partial")
          || actualCostUsd === null
          || !completedAt
          || !approvalId
          || typeof called.result.reused !== "boolean"
        ) {
          return invalid();
        }
        return {
          ok: true,
          value: {
            status,
            output: json(called.result.output),
            actualCostUsd,
            completedAt,
            approvalId,
            reused: called.result.reused,
          },
        };
      }
      return failure(called.result) ?? invalid();
    },

    async startStep(input) {
      const called = await call("start_claimed_routine_step", {
        p_user_id: input.userId,
        p_run_id: input.runId,
        p_claim_token: input.claimToken,
        p_step_key: input.stepKey,
        p_ordinal: input.ordinal,
        p_input_snapshot: input.inputSnapshot,
      });
      if (!called.ok) return called;
      if (called.result.outcome === "started" || called.result.outcome === "already_succeeded") {
        const parsed = step(called.result.step);
        if (!parsed) return invalid();
        return {
          ok: true,
          value: {
            step: parsed,
            reused: called.result.outcome === "already_succeeded"
              || called.result.reused === true,
            alreadySucceeded: called.result.outcome === "already_succeeded",
          },
        };
      }
      return failure(called.result) ?? invalid();
    },

    async completeStep(input) {
      const called = await call("complete_claimed_routine_step", {
        p_user_id: input.userId,
        p_run_id: input.runId,
        p_claim_token: input.claimToken,
        p_step_run_id: input.stepRunId,
        p_output_snapshot: input.outputSnapshot,
      });
      if (!called.ok) return called;
      if (called.result.outcome === "completed") {
        const parsed = step(called.result.step);
        return parsed && typeof called.result.reused === "boolean"
          ? { ok: true, value: { step: parsed, reused: called.result.reused } }
          : invalid();
      }
      return failure(called.result) ?? invalid();
    },

    async failStep(input) {
      const called = await call("fail_claimed_routine_step", {
        p_user_id: input.userId,
        p_run_id: input.runId,
        p_claim_token: input.claimToken,
        p_step_run_id: input.stepRunId,
        p_error_code: input.errorCode,
      });
      if (!called.ok) return called;
      if (called.result.outcome === "failed") {
        const parsed = step(called.result.step);
        return parsed && typeof called.result.reused === "boolean"
          ? { ok: true, value: { step: parsed, reused: called.result.reused } }
          : invalid();
      }
      return failure(called.result) ?? invalid();
    },
  };
}
