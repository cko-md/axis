import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getBrokerageCreds } from "../_lib";
import { logRouteTiming } from "@/lib/observability/providerTiming";
import { captureRouteError } from "@/lib/observability/captureRouteError";
import {
  preparePublicOrder,
  submitPublicOrder,
  verifyPublicOrder,
  type PublicOrderAction,
  type PublicOrderInput,
} from "@/lib/brokerage/publicOrderAdapter";
import {
  buildFundOrderIntentDraft,
  hashFundOrderIntentDraft,
  normalizeOrderIntentIdempotencyKey,
} from "@/lib/brokerage/orderIntent";
import { readBoundedJsonBody } from "@/lib/http/readBoundedJsonBody";
import { resolveRouteIdentity } from "@/lib/auth/routeIdentity";
import { EXPECTED_PROFILE_SUBJECT_HEADER } from "@/lib/auth/profileSubject";
import { profileSubjectForUserId } from "@/lib/auth/profileSubject.server";

function normalizeAction(value: unknown): PublicOrderAction | null {
  return value === "prepare" || value === "verify" || value === "submit" ? value : null;
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

async function authenticatedContext(request: NextRequest) {
  const identity = await resolveRouteIdentity(createClient, {
    route: "/api/brokerage/orders",
    area: "fund",
  });
  if (identity.ok) {
    const expectedSubject = request.headers.get(EXPECTED_PROFILE_SUBJECT_HEADER);
    if (expectedSubject && expectedSubject !== profileSubjectForUserId(identity.user.id)) {
      return { ok: false as const, status: 409, code: "SUBJECT_CHANGED" };
    }
    return { ok: true as const, user: identity.user, supabase: identity.client };
  }
  return {
    ok: false as const,
    status: identity.status,
    code: identity.status === 401 ? "Unauthorized" : identity.code,
  };
}

const INTENT_SELECT = "id, provider, action_class, symbol, side, order_type, quantity_units, quantity_scale, limit_price_minor, reference_price_minor, reference_price_source, estimated_notional_minor, currency, status, created_at";

export async function GET(request: NextRequest) {
  const auth = await authenticatedContext(request);
  if (!auth.ok) return NextResponse.json({ error: auth.code }, { status: auth.status });

  const { data, error } = await auth.supabase
    .from("fund_order_intents")
    .select(INTENT_SELECT)
    .eq("user_id", auth.user.id)
    .order("created_at", { ascending: false })
    .limit(10);
  if (error) {
    captureRouteError(error, {
      route: "brokerage_orders",
      operation: "list_intents",
      area: "fund",
      provider: "public",
      status: 500,
      code: "ORDER_INTENTS_UNAVAILABLE",
    });
    return NextResponse.json({ error: "ORDER_INTENTS_UNAVAILABLE" }, { status: 500 });
  }
  return NextResponse.json({ intents: data ?? [] }, { headers: { "cache-control": "private, no-store" } });
}

/**
 * Public order boundary.
 *
 * `prepare` writes an immutable, explicitly not-submitted intent. `verify`
 * reports configuration without making the order actionable. `submit` remains
 * disabled: neither a client approval id nor an intent is proof of execution.
 */
export async function POST(request: NextRequest) {
  const routeStartedAt = Date.now();
  const auth = await authenticatedContext(request);
  if (!auth.ok) return NextResponse.json({ error: auth.code }, { status: auth.status });

  const parsedBody = await readBoundedJsonBody(request, 8_192);
  if (!parsedBody.ok) {
    logRouteTiming("/api/brokerage/orders", routeStartedAt, { ok: false, code: "INVALID_BODY" });
    return NextResponse.json({ error: parsedBody.error }, { status: parsedBody.status });
  }
  const body = parsedBody.value;
  const action = normalizeAction(body.action);
  if (!action) {
    logRouteTiming("/api/brokerage/orders", routeStartedAt, { ok: false, code: "UNKNOWN_ORDER_ACTION" });
    return NextResponse.json({ error: "UNKNOWN_ORDER_ACTION" }, { status: 400 });
  }
  const input = orderInput(body);
  const creds = getBrokerageCreds();
  const brokerageConfigured = Boolean(creds?.apiKey);
  const accountConfigured = Boolean(creds?.accountId);

  if (action === "prepare") {
    const idempotencyKey = normalizeOrderIntentIdempotencyKey(body.idempotencyKey);
    if (!idempotencyKey) {
      return NextResponse.json({ error: "INVALID_IDEMPOTENCY_KEY" }, { status: 400 });
    }
    const result = preparePublicOrder(input);
    if (!result.ok) {
      logRouteTiming("/api/brokerage/orders", routeStartedAt, { ok: false, action, code: result.error.code });
      return NextResponse.json({ error: result.error.code, message: result.error.message }, { status: errorStatus(result.error.code) });
    }

    const draft = buildFundOrderIntentDraft(result.data);
    const payloadHash = hashFundOrderIntentDraft(draft);
    const admin = createAdminClient();
    if (!admin) {
      captureRouteError(new Error("Order intent persistence unavailable"), {
        route: "brokerage_orders",
        operation: "prepare_intent",
        area: "fund",
        provider: "public",
        status: 503,
        code: "ORDER_INTENT_PERSISTENCE_UNAVAILABLE",
      });
      return NextResponse.json({ error: "ORDER_INTENT_PERSISTENCE_UNAVAILABLE" }, { status: 503 });
    }

    const insert = {
      user_id: auth.user.id,
      provider: draft.provider,
      action_class: draft.actionClass,
      idempotency_key: idempotencyKey,
      payload_hash: payloadHash,
      symbol: draft.symbol,
      side: draft.side,
      order_type: draft.orderType,
      quantity_units: draft.quantityUnits,
      quantity_scale: draft.quantityScale,
      limit_price_minor: draft.limitPriceMinor,
      reference_price_minor: draft.referencePriceMinor,
      reference_price_source: draft.referencePriceSource,
      estimated_notional_minor: draft.estimatedNotionalMinor,
      currency: draft.currency,
      status: draft.status,
    };
    const { data, error } = await admin
      .from("fund_order_intents")
      .insert(insert)
      .select(INTENT_SELECT)
      .single();

    if (!error && data) {
      logRouteTiming("/api/brokerage/orders", routeStartedAt, { ok: true, action, deduplicated: false });
      return NextResponse.json(
        { action, intent: data, order: result.data, deduplicated: false, submitted: false },
        { status: 201, headers: { "cache-control": "private, no-store" } },
      );
    }

    if (error?.code === "23505") {
      const { data: existing, error: lookupError } = await admin
        .from("fund_order_intents")
        .select(`${INTENT_SELECT}, payload_hash`)
        .eq("user_id", auth.user.id)
        .eq("idempotency_key", idempotencyKey)
        .maybeSingle();
      if (!lookupError && existing) {
        if (existing.payload_hash !== payloadHash) {
          return NextResponse.json({ error: "IDEMPOTENCY_PAYLOAD_CONFLICT" }, { status: 409 });
        }
        const { payload_hash: _payloadHash, ...safeIntent } = existing;
        logRouteTiming("/api/brokerage/orders", routeStartedAt, { ok: true, action, deduplicated: true });
        return NextResponse.json(
          { action, intent: safeIntent, order: result.data, deduplicated: true, submitted: false },
          { headers: { "cache-control": "private, no-store" } },
        );
      }
    }

    captureRouteError(error ?? new Error("Order intent insert failed"), {
      route: "brokerage_orders",
      operation: "prepare_intent",
      area: "fund",
      provider: "public",
      status: 500,
      code: "ORDER_INTENT_CREATE_FAILED",
    });
    return NextResponse.json({ error: "ORDER_INTENT_CREATE_FAILED" }, { status: 500 });
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
      submitted: false,
    },
    { status: approvalId ? 501 : 409 },
  );
}
