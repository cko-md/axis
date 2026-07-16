import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { fundApiFailure } from "@/lib/fund/apiError";

export async function GET() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("fund_recurring_transactions")
    .select("*")
    .eq("user_id", user.id)
    .order("next_expected_date", { ascending: true });

  if (error) return fundApiFailure(error, "/api/fund/recurring", "list_recurring");
  return NextResponse.json({ recurring: data ?? [] });
}
