import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getBrokerageCreds } from "../_lib";
import { logRouteTiming, timedProviderFetch } from "@/lib/observability/providerTiming";

const PUBLIC_API_BASE = "https://api.public.com";

/** GET /api/brokerage/order-history — read-only order history. Never places orders. */
export async function GET() {
  const routeStartedAt = Date.now();
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const creds = getBrokerageCreds();
  if (!creds?.accountId) {
    logRouteTiming("/api/brokerage/order-history", routeStartedAt, { configured: false });
    return NextResponse.json(
      { configured: false, error: "APP_PUBLIC_API_KEY / APP_PUBLIC_ACCOUNT_ID not set." },
      { status: 503 },
    );
  }

  try {
    const res = await timedProviderFetch(`${PUBLIC_API_BASE}/accounts/${creds.accountId}/orders`, {
      headers: { Authorization: `Bearer ${creds.apiKey}`, Accept: "application/json" },
      next: { revalidate: 0 },
    }, { area: "fund", provider: "public", operation: "order_history", timeoutMs: 7_000, slowMs: 2_000, retry: { maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 1_500 } });

    if (!res.ok) {
      logRouteTiming("/api/brokerage/order-history", routeStartedAt, { configured: true, ok: false, status: res.status });
      return NextResponse.json({ configured: true, error: "ORDERS_FETCH_FAILED" }, { status: 502 });
    }

    const data = await res.json();
    const orders = Array.isArray(data) ? data : (data.orders ?? []);
    logRouteTiming("/api/brokerage/order-history", routeStartedAt, { configured: true, ok: true, orders: orders.length });

    return NextResponse.json({
      configured: true,
      orders: orders.map((o: Record<string, unknown>) => ({
        id: o.id ?? o.orderId,
        symbol: o.symbol ?? o.instrument,
        side: o.side,
        quantity: Number(o.quantity ?? 0),
        status: o.status,
        submittedAt: o.submittedAt ?? o.created_at,
      })),
    });
  } catch {
    logRouteTiming("/api/brokerage/order-history", routeStartedAt, { configured: true, ok: false });
    return NextResponse.json({ configured: true, error: "NETWORK_ERROR" }, { status: 502 });
  }
}
