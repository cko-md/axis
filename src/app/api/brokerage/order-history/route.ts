import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getBrokerageCreds } from "../_lib";

const PUBLIC_API_BASE = "https://api.public.com";

/** GET /api/brokerage/order-history — read-only order history. Never places orders. */
export async function GET() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const creds = getBrokerageCreds();
  if (!creds?.accountId) {
    return NextResponse.json(
      { configured: false, error: "APP_PUBLIC_API_KEY / APP_PUBLIC_ACCOUNT_ID not set." },
      { status: 503 },
    );
  }

  try {
    const res = await fetch(`${PUBLIC_API_BASE}/accounts/${creds.accountId}/orders`, {
      headers: { Authorization: `Bearer ${creds.apiKey}`, Accept: "application/json" },
      next: { revalidate: 0 },
    });

    if (!res.ok) {
      const detail = await res.text();
      console.error("[brokerage/order-history] upstream error:", res.status, detail);
      return NextResponse.json({ configured: true, error: "ORDERS_FETCH_FAILED" }, { status: 502 });
    }

    const data = await res.json();
    const orders = Array.isArray(data) ? data : (data.orders ?? []);

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
  } catch (err) {
    console.error("[brokerage/order-history] fetch error:", err);
    return NextResponse.json({ configured: true, error: "NETWORK_ERROR" }, { status: 502 });
  }
}
