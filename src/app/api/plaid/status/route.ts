import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getPlaidCreds } from "../_lib";

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

  const { count } = await supabase
    .from("plaid_items")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id);

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
