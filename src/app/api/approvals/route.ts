import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  buildApprovalRequest,
  validateApprovalCompleteness,
  type ApprovalRequestInput,
} from "@/lib/security/approvalRequest";
import { approvalRequestToInsert } from "@/lib/security/approvalPersistence";
import type { ActionClass } from "@/lib/security/actionPolicy";
import type { Json } from "@/lib/supabase/database.types";

/**
 * Approvals collection API — persists the approval object (§11.3), backed by the
 * pure policy kernel (actionPolicy + approvalRequest). Auth + owner-scoped RLS.
 *
 * GET  → the user's approvals, newest first (optional ?status=).
 * POST → build the approval from a proposed action, REJECT it if the policy says
 *        no approval is needed (nothing to persist) or if it is incomplete
 *        (never persist a bare "Allow"), then store it as `pending`.
 */

const ACTION_CLASSES: readonly ActionClass[] = [
  "READ", "DRAFT", "SIMULATE", "INTERNAL_WRITE",
  "EXTERNAL_COMMUNICATION", "FINANCIAL_EXECUTION", "DESTRUCTIVE_ADMIN",
];

const APPROVAL_STATUSES = ["pending", "approved", "denied", "expired", "executed"] as const;

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const status = request.nextUrl.searchParams.get("status");
  if (status && !(APPROVAL_STATUSES as readonly string[]).includes(status)) {
    return NextResponse.json({ error: "INVALID_STATUS" }, { status: 400 });
  }

  let query = supabase
    .from("approvals")
    .select("id, task_id, action_class, requirement, reasons, proposed_action, status, step_up_verified_at, decided_at, expires_at, scope, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });
  if (status) query = query.eq("status", status);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: "APPROVALS_UNAVAILABLE" }, { status: 500 });
  return NextResponse.json({ approvals: data ?? [] });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => null)) as Partial<ApprovalRequestInput> | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }

  const actionClass = body.context?.actionClass;
  if (!actionClass || !ACTION_CLASSES.includes(actionClass)) {
    return NextResponse.json({ error: "INVALID_ACTION_CLASS" }, { status: 400 });
  }
  if (!body.actor?.id || typeof body.tool !== "string" || typeof body.summary !== "string" || !body.target?.entityType) {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }

  const req = buildApprovalRequest(body as ApprovalRequestInput);

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
  const { data, error } = await supabase
    .from("approvals")
    // proposed_action carries opaque before/after state; it is a jsonb column.
    .insert({ ...insert, proposed_action: insert.proposed_action as unknown as Json })
    .select("id, task_id, action_class, requirement, reasons, proposed_action, status, expires_at, scope, created_at")
    .single();

  if (error || !data) return NextResponse.json({ error: "APPROVAL_CREATE_FAILED" }, { status: 500 });
  return NextResponse.json({ approval: data }, { status: 201 });
}
