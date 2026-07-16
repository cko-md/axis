import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database, Json } from "@/lib/supabase/database.types";
import type { ApprovalInsert } from "@/lib/security/approvalPersistence";

export type ApprovalRow = Database["public"]["Tables"]["approvals"]["Row"];

export type AtomicApprovalResult =
  | { ok: true; approval: ApprovalRow }
  | {
      ok: false;
      code: "SERVICE_UNAVAILABLE" | "RPC_FAILED" | "INVALID_RESPONSE" | "NOT_FOUND" | "CONFLICT";
      currentStatus?: string;
    };

export type ApprovalConsumeResult =
  | { ok: true; approval: ApprovalRow }
  | {
      ok: false;
      code:
        | "SERVICE_UNAVAILABLE"
        | "RPC_FAILED"
        | "INVALID_RESPONSE"
        | "NOT_FOUND"
        | "CONFLICT"
        | "ROUTINE_OWNED"
        | "INVALID_POLICY"
        | "NOT_ACTIONABLE"
        | "EXPIRED"
        | "STEP_UP_REQUIRED"
        | "STEP_UP_STALE";
      currentStatus?: string;
    };

export type ChallengeConsumeResult =
  | { ok: true; challengeId: string; challenge: string }
  | { ok: false; code: "SERVICE_UNAVAILABLE" | "RPC_FAILED" | "INVALID_RESPONSE" | "NOT_FOUND" };

export type StepUpCommitResult =
  | { ok: true; approval: ApprovalRow }
  | {
      ok: false;
      code:
        | "SERVICE_UNAVAILABLE"
        | "RPC_FAILED"
        | "INVALID_RESPONSE"
        | "NOT_FOUND"
        | "APPROVAL_CONFLICT"
        | "PASSKEY_NOT_FOUND"
        | "COUNTER_CONFLICT";
      currentStatus?: string;
    };

type AdminClient = SupabaseClient;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function approvalFrom(value: unknown): ApprovalRow | null {
  const row = record(value);
  return row
    && typeof row.id === "string"
    && typeof row.status === "string"
    && typeof row.action_class === "string"
    ? row as ApprovalRow
    : null;
}

function parseApprovalResult(
  data: unknown,
  successOutcome: "created" | "updated" = "updated",
): AtomicApprovalResult {
  const result = record(data);
  if (!result || typeof result.outcome !== "string") {
    return { ok: false, code: "INVALID_RESPONSE" };
  }
  if (result.outcome === successOutcome) {
    const approval = approvalFrom(result.approval);
    return approval ? { ok: true, approval } : { ok: false, code: "INVALID_RESPONSE" };
  }
  if (result.outcome === "not_found") return { ok: false, code: "NOT_FOUND" };
  if (result.outcome === "conflict") {
    return {
      ok: false,
      code: "CONFLICT",
      ...(typeof result.currentStatus === "string" ? { currentStatus: result.currentStatus } : {}),
    };
  }
  return { ok: false, code: "INVALID_RESPONSE" };
}

export async function createApprovalWithActivity(
  insert: ApprovalInsert,
  client: AdminClient | null = createAdminClient(),
): Promise<AtomicApprovalResult> {
  if (!client) return { ok: false, code: "SERVICE_UNAVAILABLE" };
  const { data, error } = await client.rpc("create_approval_with_activity", {
    p_user_id: insert.user_id,
    p_task_id: insert.task_id,
    p_action_class: insert.action_class,
    p_requirement: insert.requirement,
    p_reasons: insert.reasons,
    p_proposed_action: insert.proposed_action as unknown as Json,
    p_scope: insert.scope,
    p_expires_at: insert.expires_at,
  });
  if (error) return { ok: false, code: "RPC_FAILED" };
  return parseApprovalResult(data, "created");
}

export async function transitionApproval(
  input: {
    userId: string;
    approvalId: string;
    expectedStatus: string;
    nextStatus: string;
    decidedAt?: string | null;
  },
  client: AdminClient | null = createAdminClient(),
): Promise<AtomicApprovalResult> {
  if (!client) return { ok: false, code: "SERVICE_UNAVAILABLE" };
  const { data, error } = await client.rpc("cas_approval_transition", {
    p_user_id: input.userId,
    p_approval_id: input.approvalId,
    p_expected_status: input.expectedStatus,
    p_next_status: input.nextStatus,
    p_decided_at: input.decidedAt ?? null,
  });
  if (error) return { ok: false, code: "RPC_FAILED" };
  return parseApprovalResult(data);
}

export async function consumeActionableApproval(
  input: {
    userId: string;
    approvalId: string;
    now: string;
  },
  client: AdminClient | null = createAdminClient(),
): Promise<ApprovalConsumeResult> {
  if (!client) return { ok: false, code: "SERVICE_UNAVAILABLE" };
  const { data, error } = await client.rpc("consume_actionable_approval", {
    p_user_id: input.userId,
    p_approval_id: input.approvalId,
    p_now: input.now,
  });
  if (error) return { ok: false, code: "RPC_FAILED" };
  const result = record(data);
  if (!result || typeof result.outcome !== "string") {
    return { ok: false, code: "INVALID_RESPONSE" };
  }
  if (result.outcome === "updated") {
    const approval = approvalFrom(result.approval);
    return approval ? { ok: true, approval } : { ok: false, code: "INVALID_RESPONSE" };
  }
  if (result.outcome === "not_found") return { ok: false, code: "NOT_FOUND" };
  if (result.outcome === "conflict") {
    return {
      ok: false,
      code: "CONFLICT",
      ...(typeof result.currentStatus === "string" ? { currentStatus: result.currentStatus } : {}),
    };
  }
  const outcomes = {
    routine_owned: "ROUTINE_OWNED",
    invalid_policy: "INVALID_POLICY",
    not_actionable: "NOT_ACTIONABLE",
    expired: "EXPIRED",
    step_up_required: "STEP_UP_REQUIRED",
    step_up_stale: "STEP_UP_STALE",
  } as const;
  const code = outcomes[result.outcome as keyof typeof outcomes];
  return code ? { ok: false, code } : { ok: false, code: "INVALID_RESPONSE" };
}

export async function consumeApprovalAuthenticationChallenge(
  input: { userId: string; approvalId: string; challengeId: string; now: string },
  client: AdminClient | null = createAdminClient(),
): Promise<ChallengeConsumeResult> {
  if (!client) return { ok: false, code: "SERVICE_UNAVAILABLE" };
  const { data, error } = await client.rpc("consume_approval_authentication_challenge", {
    p_user_id: input.userId,
    p_approval_id: input.approvalId,
    p_challenge_id: input.challengeId,
    p_now: input.now,
  });
  if (error) return { ok: false, code: "RPC_FAILED" };
  const result = record(data);
  if (!result || typeof result.outcome !== "string") {
    return { ok: false, code: "INVALID_RESPONSE" };
  }
  if (result.outcome === "not_found") return { ok: false, code: "NOT_FOUND" };
  if (
    result.outcome === "consumed"
    && typeof result.challengeId === "string"
    && typeof result.challenge === "string"
  ) {
    return {
      ok: true,
      challengeId: result.challengeId,
      challenge: result.challenge,
    };
  }
  return { ok: false, code: "INVALID_RESPONSE" };
}

export async function commitApprovalStepUp(
  input: {
    userId: string;
    approvalId: string;
    expectedApprovalStatus: string;
    passkeyId: string;
    expectedCounter: number;
    newCounter: number;
    verifiedAt: string;
  },
  client: AdminClient | null = createAdminClient(),
): Promise<StepUpCommitResult> {
  if (!client) return { ok: false, code: "SERVICE_UNAVAILABLE" };
  const { data, error } = await client.rpc("commit_approval_step_up", {
    p_user_id: input.userId,
    p_approval_id: input.approvalId,
    p_expected_approval_status: input.expectedApprovalStatus,
    p_passkey_id: input.passkeyId,
    p_expected_counter: input.expectedCounter,
    p_new_counter: input.newCounter,
    p_verified_at: input.verifiedAt,
  });
  if (error) return { ok: false, code: "RPC_FAILED" };
  const result = record(data);
  if (!result || typeof result.outcome !== "string") {
    return { ok: false, code: "INVALID_RESPONSE" };
  }
  if (result.outcome === "updated") {
    const approval = approvalFrom(result.approval);
    return approval ? { ok: true, approval } : { ok: false, code: "INVALID_RESPONSE" };
  }
  if (result.outcome === "not_found") return { ok: false, code: "NOT_FOUND" };
  if (result.outcome === "approval_conflict") {
    return {
      ok: false,
      code: "APPROVAL_CONFLICT",
      ...(typeof result.currentStatus === "string" ? { currentStatus: result.currentStatus } : {}),
    };
  }
  if (result.outcome === "passkey_not_found") return { ok: false, code: "PASSKEY_NOT_FOUND" };
  if (result.outcome === "counter_conflict") return { ok: false, code: "COUNTER_CONFLICT" };
  return { ok: false, code: "INVALID_RESPONSE" };
}
