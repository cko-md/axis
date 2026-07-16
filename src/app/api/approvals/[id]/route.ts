import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  isApprovalExpired,
  validateApprovalCompleteness,
} from "@/lib/security/approvalRequest";
import { rowToApprovalRequest } from "@/lib/security/approvalPersistence";
import { emitServerEvent } from "@/lib/observability/events";
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
const ROUTE = "approvals.item";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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
    captureRouteError(readError, {
      route: ROUTE,
      operation: "read",
      area: "approvals",
      status: 500,
      code: "APPROVAL_UNAVAILABLE",
    });
    return NextResponse.json({ error: "APPROVAL_UNAVAILABLE" }, { status: 500 });
  }
  if (!row) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  if (row.status === "executing") {
    return NextResponse.json(
      { error: "APPROVAL_IN_FLIGHT", status: row.status },
      { status: 409 },
    );
  }

  const now = new Date().toISOString();

  if (action === "approve" || action === "deny") {
    if (row.status !== "pending") {
      return NextResponse.json({ error: "NOT_PENDING", status: row.status }, { status: 409 });
    }
    const admin = createAdminClient();
    if (!admin) {
      return NextResponse.json(
        {
          error: "APPROVAL_WRITE_UNAVAILABLE",
          message: "Approval writes are temporarily unavailable.",
        },
        { status: 503 },
      );
    }
    // An expired pending approval can only be marked expired, never approved.
    if (action === "approve" && isApprovalExpired(rowToApprovalRequest(row), Date.now())) {
      const { data: expired, error: expireError } = await admin
        .from("approvals")
        .update({ status: "expired", decided_at: now })
        .eq("user_id", user.id)
        .eq("id", id)
        .eq("status", "pending")
        .select("id")
        .maybeSingle();
      if (expireError) {
        captureRouteError(expireError, {
          route: ROUTE,
          operation: "expire_pending",
          area: "approvals",
          status: 500,
          code: "APPROVAL_UPDATE_FAILED",
        });
        return NextResponse.json({ error: "APPROVAL_UPDATE_FAILED" }, { status: 500 });
      }
      if (!expired) {
        return NextResponse.json(
          { error: "STALE_APPROVAL", expected: "pending" },
          { status: 409 },
        );
      }
      return NextResponse.json({ error: "EXPIRED" }, { status: 409 });
    }

    // Step-up is NEVER set here: it is set only by a verified WebAuthn assertion
    // via /api/approvals/[id]/step-up (a client can't self-attest identity).
    const patch: { status: string; decided_at: string } = {
      status: action === "approve" ? "approved" : "denied",
      decided_at: now,
    };

    const { data, error } = await admin
      .from("approvals")
      .update(patch)
      .eq("user_id", user.id)
      .eq("id", id)
      .eq("status", "pending")
      .select(SELECT)
      .maybeSingle();
    if (error) {
      captureRouteError(error, {
        route: ROUTE,
        operation: "decide",
        area: "approvals",
        status: 500,
        code: "APPROVAL_UPDATE_FAILED",
        tags: { decision: patch.status },
      });
      return NextResponse.json({ error: "APPROVAL_UPDATE_FAILED" }, { status: 500 });
    }
    if (!data) {
      return NextResponse.json(
        { error: "STALE_APPROVAL", expected: "pending" },
        { status: 409 },
      );
    }
    // Structured decision event — safe metadata only (no proposed_action / PII).
    // decision_latency_ms measures request→decide time (approval age at decision).
    emitServerEvent("approval.decided", {
      approvalId: data.id,
      decision: patch.status,
      actionClass: data.action_class,
      requirement: data.requirement,
      decisionLatencyMs: data.created_at ? Date.parse(now) - Date.parse(data.created_at) : null,
    });
    return NextResponse.json({ approval: data });
  }

  // action === "execute" — the isActionable gate.
  if (row.status !== "approved") {
    return NextResponse.json({ error: "NOT_APPROVED", status: row.status }, { status: 409 });
  }

  const { data: linkedRun, error: linkedRunError } = await supabase
    .from("routine_runs")
    .select("id, status")
    .eq("user_id", user.id)
    .eq("approval_id", id)
    .in("status", ["waiting_for_approval", "running"])
    .maybeSingle();
  if (linkedRunError) {
    captureRouteError(linkedRunError, {
      route: ROUTE,
      operation: "read_linked_run",
      area: "approvals",
      status: 500,
      code: "APPROVAL_LINK_UNAVAILABLE",
    });
    return NextResponse.json({ error: "APPROVAL_LINK_UNAVAILABLE" }, { status: 500 });
  }
  if (linkedRun) {
    return NextResponse.json(
      {
        error: "ROUTINE_RESUME_REQUIRED",
        runId: linkedRun.id,
        resumeUrl: `/api/routines/runs/${linkedRun.id}/resume`,
      },
      { status: 409 },
    );
  }

  const req = rowToApprovalRequest(row);
  const missing = validateApprovalCompleteness(req).missing;
  if (missing.length > 0) {
    return NextResponse.json(
      { error: "NOT_ACTIONABLE", reason: "INCOMPLETE", missing },
      { status: 409 },
    );
  }

  const admin = createAdminClient();
  if (!admin) {
    return NextResponse.json(
      {
        error: "APPROVAL_WRITE_UNAVAILABLE",
        message: "Approval writes are temporarily unavailable.",
      },
      { status: 503 },
    );
  }
  const { data: executionResult, error } = await admin.rpc("execute_approval", {
    p_user_id: user.id,
    p_approval_id: id,
  });
  if (error) {
    captureRouteError(error, {
      route: ROUTE,
      operation: "execute",
      area: "approvals",
      status: 500,
      code: "APPROVAL_UPDATE_FAILED",
    });
    return NextResponse.json({ error: "APPROVAL_UPDATE_FAILED" }, { status: 500 });
  }
  if (!isRecord(executionResult) || typeof executionResult.ok !== "boolean") {
    const shapeError = new Error("execute_approval returned an invalid response");
    captureRouteError(shapeError, {
      route: ROUTE,
      operation: "execute_response",
      area: "approvals",
      status: 500,
      code: "APPROVAL_UPDATE_FAILED",
    });
    return NextResponse.json({ error: "APPROVAL_UPDATE_FAILED" }, { status: 500 });
  }
  if (!executionResult.ok) {
    const code = executionResult.code;
    if (code === "ROUTINE_RESUME_REQUIRED" && typeof executionResult.runId === "string") {
      return NextResponse.json(
        {
          error: code,
          runId: executionResult.runId,
          resumeUrl: `/api/routines/runs/${executionResult.runId}/resume`,
        },
        { status: 409 },
      );
    }
    if (code === "NOT_FOUND") {
      return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    }
    if (code === "APPROVAL_IN_FLIGHT") {
      return NextResponse.json({ error: code, status: "executing" }, { status: 409 });
    }
    if (code === "APPROVAL_EXPIRED") {
      return NextResponse.json({ error: "EXPIRED" }, { status: 409 });
    }
    if (code === "APPROVAL_STEP_UP_REQUIRED" || code === "APPROVAL_STEP_UP_STALE") {
      return NextResponse.json(
        {
          error: "NOT_ACTIONABLE",
          reason: code === "APPROVAL_STEP_UP_REQUIRED" ? "STEP_UP_REQUIRED" : "STEP_UP_STALE",
          missing: [],
        },
        { status: 409 },
      );
    }
    if (code === "APPROVAL_POLICY_MISMATCH") {
      return NextResponse.json(
        { error: "NOT_ACTIONABLE", reason: "POLICY_MISMATCH", missing: [] },
        { status: 409 },
      );
    }
    if (code === "STALE_APPROVAL") {
      return NextResponse.json(
        { error: "STALE_APPROVAL", expected: "approved" },
        { status: 409 },
      );
    }

    const outcomeError = new Error(`execute_approval returned unexpected code: ${String(code)}`);
    captureRouteError(outcomeError, {
      route: ROUTE,
      operation: "execute_outcome",
      area: "approvals",
      status: 500,
      code: "APPROVAL_UPDATE_FAILED",
    });
    return NextResponse.json({ error: "APPROVAL_UPDATE_FAILED" }, { status: 500 });
  }
  if (!isRecord(executionResult.approval)) {
    const shapeError = new Error("execute_approval omitted the executed approval");
    captureRouteError(shapeError, {
      route: ROUTE,
      operation: "execute_response",
      area: "approvals",
      status: 500,
      code: "APPROVAL_UPDATE_FAILED",
    });
    return NextResponse.json({ error: "APPROVAL_UPDATE_FAILED" }, { status: 500 });
  }
  const data = executionResult.approval;
  const nowMs = Date.now();
  // Gate passed. The underlying side-effecting action is intentionally NOT
  // performed here — it is the caller's responsibility (no autonomous execution).
  emitServerEvent("approval.executed", {
    approvalId: String(data.id),
    actionClass: typeof data.action_class === "string" ? data.action_class : row.action_class,
    requirement: typeof data.requirement === "string" ? data.requirement : row.requirement,
    stepUpRequired: req.stepUpRequired,
    // Time from decision (approve) to execute — how long the actionable window sat.
    executeLatencyMs:
      typeof data.decided_at === "string" ? nowMs - Date.parse(data.decided_at) : null,
  });
  return NextResponse.json({ approval: data, cleared: true });
}
