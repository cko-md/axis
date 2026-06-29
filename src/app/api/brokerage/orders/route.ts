import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getBrokerageCreds } from "../_lib";
import { logRouteTiming, timedProviderFetch } from "@/lib/observability/providerTiming";
import { optionalEnv } from "@/lib/env";

const PUBLIC_API_BASE = "https://api.public.com";

/**
 * FIN-509: trade execution scaffold. Wired end-to-end to Public.com's order
 * endpoint but unreachable in practice — TRADE_EXECUTION_ENABLED must be
 * explicitly set to "true" or this 501s before touching the network, before
 * auth is even checked. This route is never in the Advisor's tool list
 * (src/lib/ai/tools/registry.ts) and never will be — the AI cannot reach
 * this no matter what it's asked, because the capability to call it isn't
 * something a model decides, it's something that isn't there.
 *
 * Per the original spec: autonomous trading is never allowed. Flipping
 * TRADE_EXECUTION_ENABLED only restores a manual, human-initiated order
 * ticket — it does not and must not connect this to anything the AI calls.
 */
export async function POST(request: NextRequest) {
  const routeStartedAt = Date.now();
  if (optionalEnv("TRADE_EXECUTION_ENABLED") !== "true") {
    return NextResponse.json(
      { error: "TRADE_EXECUTION_DISABLED", message: "Trade execution is disabled. This is a deliberate product decision, not a missing feature." },
      { status: 501 },
    );
  }

  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const creds = getBrokerageCreds();
  if (!creds?.accountId) {
    return NextResponse.json({ error: "APP_PUBLIC_API_KEY / APP_PUBLIC_ACCOUNT_ID not set." }, { status: 503 });
  }

  const body = await request.json().catch(() => ({}));
  const symbol = String(body.symbol ?? "").trim().toUpperCase();
  const side = body.side === "buy" || body.side === "sell" ? body.side : null;
  const quantity = Number(body.quantity);
  if (!symbol || !side || !Number.isFinite(quantity) || quantity <= 0) {
    return NextResponse.json({ error: "INVALID_ORDER" }, { status: 400 });
  }

  try {
    const res = await timedProviderFetch(`${PUBLIC_API_BASE}/accounts/${creds.accountId}/order`, {
      method: "POST",
      headers: { Authorization: `Bearer ${creds.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ symbol, side, quantity, type: "market" }),
    }, { area: "fund", provider: "public", operation: "place_order", timeoutMs: 8_000, slowMs: 2_000 });

    if (!res.ok) {
      logRouteTiming("/api/brokerage/orders", routeStartedAt, { ok: false, status: res.status });
      return NextResponse.json({ error: "ORDER_REJECTED" }, { status: 502 });
    }

    const order = await res.json();

    await supabase.from("audit_logs").insert({
      user_id: user.id,
      actor: "user",
      action: "brokerage.order_placed",
      payload: { symbol, side, quantity, order_id: order.id ?? order.orderId ?? null },
      result: "success",
    });

    logRouteTiming("/api/brokerage/orders", routeStartedAt, { ok: true });
    return NextResponse.json({ order });
  } catch {
    logRouteTiming("/api/brokerage/orders", routeStartedAt, { ok: false });
    return NextResponse.json({ error: "NETWORK_ERROR" }, { status: 502 });
  }
}
