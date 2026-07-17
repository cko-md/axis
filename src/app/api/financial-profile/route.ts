import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { captureRouteError } from "@/lib/observability/captureRouteError";
import { financialProfileSchema } from "@/lib/memory/contracts";

const SELECT_COLUMNS = "user_id, base_currency, risk_posture, investment_horizon, liquidity_buffer_months, concentration_limit_bps, priorities, constraints, source_type, confirmed_at, created_at, updated_at";

export async function GET() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  const { data, error } = await supabase
    .from("financial_operating_profiles")
    .select(SELECT_COLUMNS)
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) {
    captureRouteError(error, { route: "financial-profile", operation: "get", area: "memory", status: 500, code: "PROFILE_LOAD_FAILED" });
    return NextResponse.json({ error: "PROFILE_LOAD_FAILED" }, { status: 500 });
  }
  return NextResponse.json({ profile: data ?? null });
}
export async function PUT(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  const body = await request.json().catch(() => null);
  const parsed = financialProfileSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "INVALID_PROFILE" }, { status: 400 });

  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("financial_operating_profiles")
    .upsert({
      user_id: user.id,
      ...parsed.data,
      source_type: "user_asserted",
      confirmed_at: now,
      updated_at: now,
    }, { onConflict: "user_id" })
    .select(SELECT_COLUMNS)
    .single();
  if (error || !data) {
    captureRouteError(error, { route: "financial-profile", operation: "save", area: "memory", status: 500, code: "PROFILE_SAVE_FAILED" });
    return NextResponse.json({ error: "PROFILE_SAVE_FAILED" }, { status: 500 });
  }
  return NextResponse.json({ profile: data });
}
