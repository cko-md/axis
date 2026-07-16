import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isActionable, validateApprovalCompleteness, isApprovalExpired, isStepUpFresh } from "@/lib/security/approvalRequest";
import { rowToApprovalRequest } from "@/lib/security/approvalPersistence";
import {
  approvalEventPolicy,
  createObservabilityRequestId,
  emitServerEvent,
  eventDurationMs,
} from "@/lib/observability/events";
import {
  consumeActionableApproval,
  transitionApproval,
  type ApprovalRow as AtomicApprovalRow,
  type ApprovalConsumeResult,
  type AtomicApprovalResult,
} from "@/lib/security/approvalMutations";
import { captureRouteError } from "@/lib/observability/captureRouteError";

/**
 * Single approval API — decide (approve / deny) and execute.
 *
 * The `execute` action is the safety gate: it reconstructs the ApprovalRequest
 * from exactly what was persisted (never a client-supplied version) and re-runs
 * `isActionable` — complete + unexpired + step-up satisfied — before clearing the
 * approval. It records that the gate passed (status = executed); it does NOT
 * itself perform the underlying financial/external action. There is no
 * autonomous financial execution here by design (§7 / §11.2).
 */

const SELECT =
  "id, task_id, action_class, requirement, reasons, proposed_action, status, step_up_verified_at, decided_at, expires_at, scope, created_at";

function approvalResponse(row: AtomicApprovalRow) {
  return {
    id: row.id,
    task_id: row.task_id,
    action_class: row.action_class,
    requirement: row.requirement,
    reasons: row.reasons,
    proposed_action: row.proposed_action,
    status: row.status,
    step_up_verified_at: row.step_up_verified_at,
    decided_at: row.decided_at,
    expires_at: row.expires_at,
    scope: row.scope,
    created_at: row.created_at,
  };
}

function mutationFailure(
  result: Exclude<AtomicApprovalResult, { ok: true }>,
  requestId: string,
) {
  if (result.code === "NOT_FOUND") {
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }
  if (result.code === "CONFLICT") {
    return NextResponse.json(
      { error: "STALE_APPROVAL_STATE", currentStatus: result.currentStatus },
      { status: 409 },
    );
  }
  const status = result.code === "SERVICE_UNAVAILABLE" ? 503 : 500;
  const code = result.code === "SERVICE_UNAVAILABLE"
    ? "APPROVAL_MUTATION_UNAVAILABLE"
    : "APPROVAL_UPDATE_FAILED";
  captureRouteError(new Error(code), {
    route: "approvals",
    operation: "transition",
    area: "approvals",
    status,
    code,
    tags: { requestId },
  });
  return NextResponse.json({ error: code }, { status });
}

function consumeFailure(
  result: Exclude<ApprovalConsumeResult, { ok: true }>,
  requestId: string,
) {
  if (result.code === "NOT_FOUND") {
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }
  if (result.code === "CONFLICT") {
    return NextResponse.json(
      { error: "STALE_APPROVAL_STATE", currentStatus: result.currentStatus },
      { status: 409 },
    );
  }
  if (result.code === "ROUTINE_OWNED") {
    return NextResponse.json({ error: "ROUTINE_RESUME_REQUIRED" }, { status: 409 });
  }
  if (result.code === "EXPIRED") {
    return NextResponse.json({ error: "EXPIRED" }, { status: 409 });
  }
  if (result.code === "STEP_UP_REQUIRED" || result.code === "STEP_UP_STALE") {
    return NextResponse.json(
      { error: "NOT_ACTIONABLE", reason: result.code },
      { status: 409 },
    );
  }
  if (result.code === "INVALID_POLICY" || result.code === "NOT_ACTIONABLE") {
    captureRouteError(new Error("Stored approval policy invariant failed"), {
      route: "approvals",
      operation: "execute",
      area: "approvals",
      status: 500,
      code: "APPROVAL_POLICY_INVALID",
      tags: { requestId },
    });
    return NextResponse.json(
      {
        error: "NOT_ACTIONABLE",
        reason: result.code === "INVALID_POLICY"
          ? "POLICY_MISMATCH"
          : "INCOMPLETE",
      },
      { status: 409 },
    );
  }
  const status = result.code === "SERVICE_UNAVAILABLE" ? 503 : 500;
  const code = result.code === "SERVICE_UNAVAILABLE"
    ? "APPROVAL_MUTATION_UNAVAILABLE"
    : "APPROVAL_UPDATE_FAILED";
  captureRouteError(new Error(code), {
    route: "approvals",
    operation: "execute",
    area: "approvals",
    status,
    code,
    tags: { requestId },
  });
  return NextResponse.json({ error: code }, { status });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const requestId = createObservabilityRequestId();
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as { action?: string };
  const action = body.action;
  if (action !== "approve" && action !== "deny" && action !== "execute") {
    return NextResponse.json({ error: "INVALID_ACTION" }, { status: 400 });
  }

  const { data: row, error: readError } = await supabase
    .from("approvals")
    .select(SELECT)
    .eq("user_id", user.id)
    .eq("id", id)
    .maybeSingle();
  if (readError) {
    captureRouteError(new Error("Approval lookup failed"), {
      route: "approvals",
      operation: "read",
      area: "approvals",
      status: 500,
      code: "APPROVAL_UNAVAILABLE",
      tags: { requestId },
    });
    return NextResponse.json({ error: "APPROVAL_UNAVAILABLE" }, { status: 500 });
  }
  if (!row) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  const now = new Date().toISOString();
  const storedRequest = rowToApprovalRequest(row);
  const eventPolicy = approvalEventPolicy(
    storedRequest.actionClass,
    storedRequest.requirement,
  );

  if (action === "approve" || action === "deny") {
    if (row.status !== "pending") {
      return NextResponse.json({ error: "NOT_PENDING", status: row.status }, { status: 409 });
    }
    // An expired pending approval can only be marked expired, never approved.
    if (action === "approve" && isApprovalExpired(storedRequest, Date.now())) {
      const expired = await transitionApproval({
        userId: user.id,
        approvalId: id,
        expectedStatus: "pending",
        nextStatus: "expired",
        decidedAt: now,
      });
      if (!expired.ok) return mutationFailure(expired, requestId);
      return NextResponse.json({ error: "EXPIRED" }, { status: 409 });
    }

    // Step-up is NEVER set here: it is set only by a verified WebAuthn assertion
    // via /api/approvals/[id]/step-up (a client can't self-attest identity).
    const decision = action === "approve" ? "approved" : "denied";
    const patch: { status: typeof decision; decided_at: string } = {
      status: decision,
      decided_at: now,
    };

    const result = await transitionApproval({
      userId: user.id,
      approvalId: id,
      expectedStatus: "pending",
      nextStatus: patch.status,
      decidedAt: now,
    });
    if (!result.ok) return mutationFailure(result, requestId);
    const data = result.approval;
    // Structured decision event — safe metadata only (no proposed_action / PII).
    // decision_latency_ms measures request→decide time (approval age at decision).
    if (eventPolicy) {
      emitServerEvent("approval.decided", {
        requestId,
        approvalId: data.id,
        decision,
        ...eventPolicy,
        decisionLatencyMs: eventDurationMs(data.created_at, Date.parse(now)),
      });
    } else {
      captureRouteError(new Error("Stored approval event policy invalid"), {
        route: "approvals",
        operation: "decision_event",
        area: "approvals",
        status: 500,
        code: "APPROVAL_POLICY_INVALID",
        tags: { requestId },
      });
    }
    return NextResponse.json({ approval: approvalResponse(data) });
  }

  // action === "execute" — the isActionable gate.
  if (row.status !== "approved") {
    return NextResponse.json({ error: "NOT_APPROVED", status: row.status }, { status: 409 });
  }

  const req = storedRequest;
  const nowMs = Date.now();
  const stepUpFresh = isStepUpFresh(row.step_up_verified_at, undefined, nowMs);

  if (isApprovalExpired(req, nowMs)) {
    const expired = await transitionApproval({
      userId: user.id,
      approvalId: id,
      expectedStatus: "approved",
      nextStatus: "expired",
    });
    if (!expired.ok) return mutationFailure(expired, requestId);
    return NextResponse.json({ error: "EXPIRED" }, { status: 409 });
  }
  if (!isActionable(req, { stepUpVerifiedAt: row.step_up_verified_at, nowMs })) {
    const missing = validateApprovalCompleteness(req).missing;
    // Distinguish "never verified" from "verified too long ago" so the UI can
    // prompt a re-verify rather than a generic error.
    const reason = req.stepUpRequired && !stepUpFresh
      ? (row.step_up_verified_at ? "STEP_UP_STALE" : "STEP_UP_REQUIRED")
      : "INCOMPLETE";
    return NextResponse.json({ error: "NOT_ACTIONABLE", reason, missing }, { status: 409 });
  }

  const result = await consumeActionableApproval({
    userId: user.id,
    approvalId: id,
    now,
  });
  if (!result.ok) return consumeFailure(result, requestId);
  const data = result.approval;
  // Gate passed. The underlying side-effecting action is intentionally NOT
  // performed here — it is the caller's responsibility (no autonomous execution).
  if (eventPolicy) {
    emitServerEvent("approval.executed", {
      requestId,
      approvalId: data.id,
      ...eventPolicy,
      stepUpRequired: req.stepUpRequired,
      // Time from decision (approve) to execute — how long the actionable window sat.
      executeLatencyMs: eventDurationMs(data.decided_at, nowMs),
    });
  } else {
    captureRouteError(new Error("Stored approval event policy invalid"), {
      route: "approvals",
      operation: "execution_event",
      area: "approvals",
      status: 500,
      code: "APPROVAL_POLICY_INVALID",
      tags: { requestId },
    });
  }
  return NextResponse.json({ approval: approvalResponse(data), cleared: true });
}
