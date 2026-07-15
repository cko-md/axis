import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getBrokerageCreds } from "../_lib";
import { logRouteTiming } from "@/lib/observability/providerTiming";
import {
  preparePublicOrder,
  submitPublicOrder,
  verifyPublicOrder,
  type PublicOrderAction,
  type PublicOrderInput,
} from "@/lib/brokerage/publicOrderAdapter";

function normalizeAction(value: unknown): PublicOrderAction {
  return value === "verify" || value === "submit" ? value : "prepare";
}

function orderInput(body: Record<string, unknown>): PublicOrderInput {
  const nested = body.order && typeof body.order === "object" ? body.order as Record<string, unknown> : body;
  return {
    symbol: nested.symbol,
    side: nested.side,
    quantity: nested.quantity,
    type: nested.type,
    limitPrice: nested.limitPrice,
    limit_price: nested.limit_price,
    referencePrice: nested.referencePrice,
    reference_price: nested.reference_price,
    currency: nested.currency,
  };
}

function errorStatus(code: string): number {
  if (code === "invalid_request") return 400;
  if (code === "not_supported") return 501;
  return 502;
}

/**
 * Public order boundary.
 *
 * `prepare` and `verify` build deterministic order drafts for review. `submit`
 * deliberately does not place live orders: a client-provided approval id is not
 * authorization. A future execution adapter must be called only from the
 * server-side approval kernel after isActionable + fresh step-up.
 */
export async function POST(request: NextRequest) {
  const routeStartedAt = Date.now();
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    body = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    logRouteTiming("/api/brokerage/orders", routeStartedAt, { ok: false, code: "INVALID_BODY" });
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }

  const action = normalizeAction(body.action);
  const input = orderInput(body);
  const creds = getBrokerageCreds();
  const brokerageConfigured = Boolean(creds?.apiKey);
  const accountConfigured = Boolean(creds?.accountId);

  if (action === "prepare") {
    const result = preparePublicOrder(input);
    if (!result.ok) {
      logRouteTiming("/api/brokerage/orders", routeStartedAt, { ok: false, action, code: result.error.code });
      return NextResponse.json({ error: result.error.code, message: result.error.message }, { status: errorStatus(result.error.code) });
    }
    logRouteTiming("/api/brokerage/orders", routeStartedAt, { ok: true, action });
    return NextResponse.json({
      action,
      order: result.data,
      approvalRequired: true,
      stepUpRequired: true,
      submitEnabled: false,
    });
  }

  if (action === "verify") {
    const result = verifyPublicOrder(input, { brokerageConfigured, accountConfigured });
    if (!result.ok) {
      logRouteTiming("/api/brokerage/orders", routeStartedAt, { ok: false, action, code: result.error.code });
      return NextResponse.json({ error: result.error.code, message: result.error.message }, { status: errorStatus(result.error.code) });
    }
    logRouteTiming("/api/brokerage/orders", routeStartedAt, { ok: true, action, configured: brokerageConfigured, accountConfigured });
    return NextResponse.json({ action, verification: result.data });
  }

  const prepared = preparePublicOrder(input);
  if (!prepared.ok) {
    logRouteTiming("/api/brokerage/orders", routeStartedAt, { ok: false, action, code: prepared.error.code });
    return NextResponse.json({ error: prepared.error.code, message: prepared.error.message }, { status: errorStatus(prepared.error.code) });
  }

  const approvalId = typeof body.approvalId === "string" ? body.approvalId.trim() : "";
  const result = approvalId ? null : submitPublicOrder(input);
  logRouteTiming("/api/brokerage/orders", routeStartedAt, {
    ok: false,
    action,
    code: approvalId ? "not_supported" : result?.ok ? "UNEXPECTED_OK" : result?.error.code,
    approvalProvided: Boolean(approvalId),
  });
  return NextResponse.json(
    {
      error: approvalId ? "BROKER_SUBMIT_NOT_ENABLED" : "APPROVAL_REQUIRED",
      message: approvalId
        ? "Live Public order submission is not enabled. Approval ids are only actionable through a server-side execution adapter."
        : result?.ok ? "Approval required." : result?.error.message,
      approvalRequired: true,
      stepUpRequired: true,
      submitEnabled: false,
    },
    { status: approvalId ? 501 : 409 },
  );
}
