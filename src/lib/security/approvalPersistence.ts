/**
 * Pure mapping between the approvals table row and the ApprovalRequest contract
 * (src/lib/security/approvalRequest.ts). Kept separate and unit-tested so the
 * API route stays thin and the round-trip is verifiable — the execute path
 * reconstructs an ApprovalRequest from the row to re-run `isActionable`, so the
 * mapping must be faithful.
 */

import type { Json } from "@/lib/supabase/database.types";
import type { ActionClass, ApprovalRequirement } from "./actionPolicy";
import type {
  ApprovalActor,
  ApprovalAmount,
  ApprovalDataFreshness,
  ApprovalRequest,
  ApprovalScope,
  ApprovalTarget,
} from "./approvalRequest";

/** The non-column payload we persist in approvals.proposed_action (jsonb). */
export type StoredProposedAction = {
  actor: ApprovalActor;
  tool: string;
  summary: string;
  touchesSensitiveData?: boolean;
  usesUntrustedExternalContent?: boolean;
  explicitlyTrusted?: boolean;
  target: ApprovalTarget;
  amount?: ApprovalAmount;
  beforeState?: unknown;
  afterState?: unknown;
  dataFreshness?: ApprovalDataFreshness;
};

/** The subset of the approvals row this mapping needs. */
export type ApprovalRow = {
  action_class: string;
  requirement: string;
  reasons: string[];
  proposed_action: Json;
  scope: string;
  expires_at: string | null;
  task_id: string | null;
  step_up_verified_at: string | null;
};

/** The insert payload derived from an ApprovalRequest (minus id/status/timestamps). */
export type ApprovalInsert = {
  user_id: string;
  task_id: string | null;
  action_class: ActionClass;
  requirement: ApprovalRequirement;
  reasons: string[];
  proposed_action: StoredProposedAction;
  scope: ApprovalScope;
  expires_at: string | null;
};

/**
 * Serialize an ApprovalRequest into a table insert. The action-class columns are
 * promoted to real columns (for querying/constraints); everything else — the
 * exact proposed action shown to the user — lives in proposed_action.
 */
export function approvalRequestToInsert(req: ApprovalRequest, userId: string): ApprovalInsert {
  const proposed: StoredProposedAction = {
    actor: req.actor,
    tool: req.tool,
    summary: req.summary,
    touchesSensitiveData: req.context.touchesSensitiveData,
    usesUntrustedExternalContent: req.context.usesUntrustedExternalContent,
    explicitlyTrusted: req.context.explicitlyTrusted,
    target: req.target,
    amount: req.amount,
    beforeState: req.beforeState,
    afterState: req.afterState,
    dataFreshness: req.dataFreshness,
  };
  return {
    user_id: userId,
    task_id: req.taskId ?? null,
    action_class: req.actionClass,
    requirement: req.requirement,
    reasons: req.reasons,
    proposed_action: proposed,
    scope: req.scope,
    expires_at: req.expiresAt ?? null,
  };
}

/**
 * Reconstruct the ApprovalRequest from a stored row so the execute path can
 * re-run validateApprovalCompleteness / isApprovalExpired / isActionable against
 * exactly what was persisted (never trusting a client-supplied version).
 */
export function rowToApprovalRequest(row: ApprovalRow): ApprovalRequest {
  const pa = (row.proposed_action ?? {}) as StoredProposedAction;
  return {
    actor: pa.actor,
    tool: pa.tool,
    summary: pa.summary,
    context: {
      actionClass: row.action_class as ActionClass,
      touchesSensitiveData: pa.touchesSensitiveData,
      usesUntrustedExternalContent: pa.usesUntrustedExternalContent,
      explicitlyTrusted: pa.explicitlyTrusted,
    },
    target: pa.target,
    amount: pa.amount,
    beforeState: pa.beforeState,
    afterState: pa.afterState,
    dataFreshness: pa.dataFreshness,
    actionClass: row.action_class as ActionClass,
    requirement: row.requirement as ApprovalRequirement,
    reasons: row.reasons ?? [],
    stepUpRequired: row.requirement === "approval_step_up",
    scope: row.scope as ApprovalScope,
    expiresAt: row.expires_at ?? undefined,
    taskId: row.task_id ?? undefined,
  };
}
