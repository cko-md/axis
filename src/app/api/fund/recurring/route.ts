import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { redactRouteError } from "@/lib/observability/redactRouteError";
import { resolveRouteIdentity } from "@/lib/auth/routeIdentity";

export async function GET() {
  const identity = await resolveRouteIdentity(createClient, { route: "/api/fund/recurring", area: "fund" });
  if (!identity.ok) return NextResponse.json({ error: identity.code }, { status: identity.status });
  const { client: supabase, user } = identity;

  const { data, error } = await supabase
    .from("fund_recurring_transactions")
    .select("*")
    .eq("user_id", user.id)
    .order("next_expected_date", { ascending: true });

  if (error) return redactRouteError(error, { route: "fund/recurring", area: "fund" });
  return NextResponse.json({ recurring: data ?? [] });
}
