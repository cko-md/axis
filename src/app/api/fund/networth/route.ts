import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Net-worth time series.
 *
 * GET  → last ~120 days of daily snapshots for the authenticated user, ascending.
 * POST → upsert today's snapshot from the client-computed { cash, invested }.
 *        These are the user's own displayed totals (cash from Plaid balances,
 *        invested from fund_holdings); RLS scopes every row to the owner. The
 *        unique (user_id, captured_on) constraint keeps this to one row per day,
 *        updated in place on repeat visits.
 */

export async function GET() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const since = new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from("net_worth_snapshots")
    .select("captured_on, cash, invested, liabilities, net_worth")
    .eq("user_id", user.id)
    .gte("captured_on", since)
    .order("captured_on", { ascending: true });

  if (error) return NextResponse.json({ snapshots: [] });
  return NextResponse.json({ snapshots: data ?? [] });
}

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let cash = 0;
  let invested = 0;
  let liabilities = 0;
  try {
    const body = await req.json();
    cash = Number(body.cash) || 0;
    invested = Number(body.invested) || 0;
    liabilities = Number(body.liabilities) || 0;
  } catch {
    /* default to zeros */
  }

  const net_worth = cash + invested - liabilities;
  const captured_on = new Date().toISOString().slice(0, 10);

  const { error } = await supabase
    .from("net_worth_snapshots")
    .upsert(
      { user_id: user.id, captured_on, cash, invested, liabilities, net_worth },
      { onConflict: "user_id,captured_on" },
    );

  if (error) return NextResponse.json({ error: "SNAPSHOT_FAILED" }, { status: 500 });
  return NextResponse.json({ ok: true });
}
