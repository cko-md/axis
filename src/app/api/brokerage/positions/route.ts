import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getBrokerageCreds } from "../_lib";

const PUBLIC_API_BASE = "https://api.public.com";

/**
 * GET /api/brokerage/positions
 *
 * Read-only positions for the configured Public.com account. Holdings sourced
 * here are tagged source="public" by the caller — never merged with Plaid or
 * manual rows (decision #9: aggregate by symbol at the analytics layer, don't
 * collapse rows from different sources).
 */
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
    const res = await fetch(`${PUBLIC_API_BASE}/accounts/${creds.accountId}/portfolio`, {
      headers: { Authorization: `Bearer ${creds.apiKey}`, Accept: "application/json" },
      next: { revalidate: 0 },
    });

    if (!res.ok) {
      const detail = await res.text();
      console.error("[brokerage/positions] upstream error:", res.status, detail);
      return NextResponse.json({ configured: true, error: "POSITIONS_FETCH_FAILED" }, { status: 502 });
    }

    const data = await res.json();
    const positions = Array.isArray(data) ? data : (data.positions ?? data.holdings ?? []);

    return NextResponse.json({
      configured: true,
      positions: positions.map((p: Record<string, unknown>) => ({
        symbol: p.symbol ?? p.instrument,
        shares: Number(p.quantity ?? p.shares ?? 0),
        costBasis: Number(p.costBasis ?? p.cost_basis ?? 0),
        marketValue: Number(p.marketValue ?? p.market_value ?? 0),
      })),
    });
  } catch (err) {
    console.error("[brokerage/positions] fetch error:", err);
    return NextResponse.json({ configured: true, error: "NETWORK_ERROR" }, { status: 502 });
  }
}
