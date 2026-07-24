import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createClient } from "@/lib/supabase/server";

/**
 * Net-worth time series.
 *
 * GET  → last ~120 days of daily snapshots for the authenticated user, ascending.
 * Snapshot writes are service-side only: the finance-daily job persists a
 * complete provider-authoritative input set. Browser totals are presentation
 * values and must never become historical financial records.
 */

export async function GET() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const since = new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from("net_worth_snapshots_exact")
    .select("captured_on, cash, invested, liabilities, net_worth, computed_at, input_as_of, calculation_hash, authority, snapshot_status, currency, calculation_version")
    .eq("user_id", user.id)
    .eq("authority", "provider")
    .eq("snapshot_status", "fresh")
    .eq("currency", "USD")
    .eq("calculation_version", "financial-truth-v2")
    .gte("captured_on", since)
    .order("captured_on", { ascending: true });

  if (error) {
    Sentry.captureException(new Error("Fund net-worth snapshots unavailable"), {
      tags: { area: "fund", operation: "net_worth_history", code: "SNAPSHOTS_UNAVAILABLE" },
    });
    return NextResponse.json({ error: "SNAPSHOTS_UNAVAILABLE" }, { status: 500 });
  }
  return NextResponse.json({ snapshots: data ?? [] });
}

export async function POST(req: NextRequest) {
  void req;
  return NextResponse.json({ error: "SNAPSHOT_WRITES_SERVER_ONLY" }, { status: 405, headers: { Allow: "GET" } });
}
