import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getBrokerageCreds } from "../_lib";
import { captureRouteError } from "@/lib/observability/captureRouteError";

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
  const { data: connections, error } = await supabase
    .from("fund_connections")
    .select("institution, status, updated_at")
    .eq("user_id", user.id)
    .eq("provider", "public")
    .order("updated_at", { ascending: false });

  if (error) {
    captureRouteError(error, {
      route: "/api/brokerage/status",
      operation: "read_connection_status",
      area: "fund",
      provider: "supabase",
      status: 500,
    });
    return NextResponse.json({ error: "STATUS_UNAVAILABLE", message: "Could not read brokerage connection status." }, { status: 500 });
  }

  const linkedConnections = (connections ?? []).filter((connection) => connection.status === "linked");
  const latestConnection = connections?.[0] ?? null;

  return NextResponse.json({
    configured: !!creds,
    linked: linkedConnections.length > 0,
    connectionCount: linkedConnections.length,
    latestConnection: latestConnection
      ? {
          institution: latestConnection.institution,
          status: latestConnection.status,
          updatedAt: latestConnection.updated_at,
        }
      : null,
    provider: "public",
    message: creds
      ? "Brokerage (Public.com) is configured server-side."
      : "Add APP_PUBLIC_API_KEY to enable order routing through Public.com. Orders are logged locally until then.",
  });
}
