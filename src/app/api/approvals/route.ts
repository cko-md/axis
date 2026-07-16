import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  buildApprovalRequest,
  parseApprovalRequestInput,
  validateApprovalCompleteness,
} from "@/lib/security/approvalRequest";
import { approvalRequestToInsert } from "@/lib/security/approvalPersistence";
import { createApprovalWithActivity } from "@/lib/security/approvalMutations";
import { captureRouteError } from "@/lib/observability/captureRouteError";

/**
 * Approvals collection API — persists the approval object (§11.3), backed by the
 * pure policy kernel (actionPolicy + approvalRequest). Auth + owner-scoped RLS.
 *
 * GET  → the user's approvals, newest first (optional ?status=).
 * POST → build the approval from a proposed action, REJECT it if the policy says
 *        no approval is needed (nothing to persist) or if it is incomplete
 *        (never persist a bare "Allow"), then store it as `pending`.
 */

const APPROVAL_STATUSES = ["pending", "approved", "denied", "expired", "executed"] as const;

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const status = request.nextUrl.searchParams.get("status");
  if (status && !(APPROVAL_STATUSES as readonly string[]).includes(status)) {
    return NextResponse.json({ error: "INVALID_STATUS" }, { status: 400 });
  }
  const taskId = request.nextUrl.searchParams.get("taskId");

  let query = supabase
    .from("approvals")
    .select("id, task_id, action_class, requirement, reasons, proposed_action, status, step_up_verified_at, decided_at, expires_at, scope, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });
  if (status) query = query.eq("status", status);
  if (taskId) query = query.eq("task_id", taskId);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: "APPROVALS_UNAVAILABLE" }, { status: 500 });
  return NextResponse.json({ approvals: data ?? [] });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body: unknown = await request.json().catch(() => null);
  const parsed = parseApprovalRequestInput(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.code }, { status: 400 });
  }
  // This browser-facing boundary represents only the authenticated user. Agent
  // and routine attribution is reserved for trusted server callers so a client
  // cannot forge who proposed a privileged action.
  if (parsed.value.actor.kind !== "user" || parsed.value.actor.id !== user.id) {
    return NextResponse.json({ error: "INVALID_ACTOR" }, { status: 400 });
  }

  const req = buildApprovalRequest(parsed.value);

  // Nothing to approve — the policy lets this run automatically. Don't persist a
  // meaningless approval row.
  if (req.requirement === "auto") {
    return NextResponse.json({ error: "NO_APPROVAL_NEEDED" }, { status: 400 });
  }

  // Never persist a bare "Allow": the approval must show its full scope.
  const completeness = validateApprovalCompleteness(req);
  if (!completeness.complete) {
    return NextResponse.json(
      { error: "INCOMPLETE_APPROVAL", missing: completeness.missing },
      { status: 400 },
    );
  }

  const insert = approvalRequestToInsert(req, user.id);
  const result = await createApprovalWithActivity(insert);
  if (!result.ok) {
    const status = result.code === "SERVICE_UNAVAILABLE" ? 503 : 500;
    const code = result.code === "SERVICE_UNAVAILABLE"
      ? "APPROVAL_MUTATION_UNAVAILABLE"
      : "APPROVAL_CREATE_FAILED";
    captureRouteError(new Error(code), {
      route: "approvals",
      operation: "create",
      area: "approvals",
      status,
      code,
    });
    return NextResponse.json({ error: code }, { status });
  }
  return NextResponse.json({ approval: result.approval }, { status: 201 });
}
