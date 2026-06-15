import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getBrokerageCreds } from "../_lib";

/**
 * Brokerage (Public.com) connectivity status. Generic scaffold behind a
 * setup-state, matching /api/massive/status and /api/plaid/status. Returns
 * { configured: false } with no error when keys are absent so the order
 * ticket can route to local-log mode and show a "Connect Public" prompt.
 */

export async function GET() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const creds = getBrokerageCreds();
  return NextResponse.json({
    configured: !!creds,
    provider: "public",
    message: creds
      ? "Brokerage (Public.com) is configured server-side."
      : "Add APP_PUBLIC_API_KEY to enable order routing through Public.com. Orders are logged locally until then.",
  });
}
