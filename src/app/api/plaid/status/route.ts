import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getPlaidCreds } from "../_lib";
import { captureRouteError } from "@/lib/observability/captureRouteError";

/**
 * Plaid connectivity status. Mirrors /api/massive/status: returns a clean
 * "not configured" setup-state when PLAID_CLIENT_ID / PLAID_SECRET are unset,
 * so the UI can render a "Connect bank via Plaid" affordance with no errors.
 */

export async function GET() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const creds = getPlaidCreds();

  const { count, error } = await supabase
    .from("fund_connections")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .eq("provider", "plaid")
    .eq("status", "linked");
  if (error) {
    captureRouteError(error, {
      route: "/api/plaid/status",
      operation: "read_connection_status",
      area: "fund",
      provider: "supabase",
      status: 500,
    });
    return NextResponse.json({ error: "STATUS_UNAVAILABLE", message: "Could not read Plaid connection status." }, { status: 500 });
  }

  return NextResponse.json({
    configured: !!creds,
    linked: (count ?? 0) > 0,
    provider: "plaid",
    env: creds?.env ?? null,
    message: creds
      ? "Plaid is configured server-side."
      : "Add PLAID_CLIENT_ID and PLAID_SECRET to enable bank linking via Plaid.",
  });
}
