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

const MAX_BALANCE = 1_000_000_000_000;

function parseSnapshotValue(value: unknown, field: string, options?: { allowNegative?: boolean }) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || Math.abs(parsed) > MAX_BALANCE) {
    return { error: `INVALID_${field.toUpperCase()}` };
  }
  if (!options?.allowNegative && parsed < 0) {
    return { error: `INVALID_${field.toUpperCase()}` };
  }
  return { value: parsed };
}

export async function GET() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const since = new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from("net_worth_snapshots")
    .select("captured_on, cash, invested, liabilities, net_worth, computed_at")
    .eq("user_id", user.id)
    .gte("captured_on", since)
    .order("captured_on", { ascending: true });

  if (error) return NextResponse.json({ error: "SNAPSHOTS_UNAVAILABLE" }, { status: 500 });
  return NextResponse.json({ snapshots: data ?? [] });
}

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    const parsed = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }

  const cashValue = parseSnapshotValue(body.cash, "cash", { allowNegative: true });
  const investedValue = parseSnapshotValue(body.invested, "invested");
  const liabilitiesValue = parseSnapshotValue(body.liabilities ?? 0, "liabilities");
  const firstError = cashValue.error ?? investedValue.error ?? liabilitiesValue.error;
  if (firstError) {
    return NextResponse.json({ error: firstError }, { status: 400 });
  }

  const cash = cashValue.value ?? 0;
  const invested = investedValue.value ?? 0;
  const liabilities = liabilitiesValue.value ?? 0;
  const net_worth = cash + invested - liabilities;
  const captured_on = new Date().toISOString().slice(0, 10);

  const { error } = await supabase
    .from("net_worth_snapshots")
    .upsert(
      // computed_at stamps the actual recomputation time so the freshness badge
      // reflects the last update, not the day-granular captured_on.
      { user_id: user.id, captured_on, cash, invested, liabilities, net_worth, computed_at: new Date().toISOString() },
      { onConflict: "user_id,captured_on" },
    );

  if (error) return NextResponse.json({ error: "SNAPSHOT_FAILED" }, { status: 500 });
  return NextResponse.json({ ok: true });
}
