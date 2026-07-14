import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isActionable, validateApprovalCompleteness, isApprovalExpired, isStepUpFresh } from "@/lib/security/approvalRequest";
import { rowToApprovalRequest } from "@/lib/security/approvalPersistence";

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
  if (readError) return NextResponse.json({ error: "APPROVAL_UNAVAILABLE" }, { status: 500 });
  if (!row) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  const now = new Date().toISOString();

  if (action === "approve" || action === "deny") {
    if (row.status !== "pending") {
      return NextResponse.json({ error: "NOT_PENDING", status: row.status }, { status: 409 });
    }
    // An expired pending approval can only be marked expired, never approved.
    if (action === "approve" && isApprovalExpired(rowToApprovalRequest(row), Date.now())) {
      await supabase.from("approvals").update({ status: "expired", decided_at: now }).eq("user_id", user.id).eq("id", id);
      return NextResponse.json({ error: "EXPIRED" }, { status: 409 });
    }

    // Step-up is NEVER set here: it is set only by a verified WebAuthn assertion
    // via /api/approvals/[id]/step-up (a client can't self-attest identity).
    const patch: { status: string; decided_at: string } = {
      status: action === "approve" ? "approved" : "denied",
      decided_at: now,
    };

    const { data, error } = await supabase
      .from("approvals").update(patch).eq("user_id", user.id).eq("id", id).select(SELECT).single();
    if (error || !data) return NextResponse.json({ error: "APPROVAL_UPDATE_FAILED" }, { status: 500 });
    return NextResponse.json({ approval: data });
  }

  // action === "execute" — the isActionable gate.
  if (row.status !== "approved") {
    return NextResponse.json({ error: "NOT_APPROVED", status: row.status }, { status: 409 });
  }

  const req = rowToApprovalRequest(row);
  const nowMs = Date.now();
  const stepUpFresh = isStepUpFresh(row.step_up_verified_at, undefined, nowMs);

  if (isApprovalExpired(req, nowMs)) {
    await supabase.from("approvals").update({ status: "expired" }).eq("user_id", user.id).eq("id", id);
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

  const { data, error } = await supabase
    .from("approvals").update({ status: "executed" }).eq("user_id", user.id).eq("id", id).select(SELECT).single();
  if (error || !data) return NextResponse.json({ error: "APPROVAL_UPDATE_FAILED" }, { status: 500 });
  // Gate passed. The underlying side-effecting action is intentionally NOT
  // performed here — it is the caller's responsibility (no autonomous execution).
  return NextResponse.json({ approval: data, cleared: true });
}
