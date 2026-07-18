import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { redactRouteError } from "@/lib/observability/redactRouteError";

export async function GET() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("fund_recurring_transactions")
    .select("*")
    .eq("user_id", user.id)
    .order("next_expected_date", { ascending: true });

  if (error) return redactRouteError(error, { route: "fund/recurring", area: "fund" });
  return NextResponse.json({ recurring: data ?? [] });
}
