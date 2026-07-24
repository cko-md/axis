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
  let supabase: Awaited<ReturnType<typeof createClient>>;
  try { supabase = await createClient(); } catch {
    return NextResponse.json({ error: "AUTH_UNAVAILABLE" }, { status: 503 });
  }
  let authResult: Awaited<ReturnType<typeof supabase.auth.getUser>>;
  try { authResult = await supabase.auth.getUser(); } catch {
    return NextResponse.json({ error: "AUTH_UNAVAILABLE" }, { status: 503 });
  }
  const { data: { user }, error: authError } = authResult;
  if (authError) {
    captureRouteError(new Error("Plaid status authentication unavailable"), {
      route: "/api/plaid/status", operation: "authenticate", area: "fund",
      provider: "supabase", status: 503, code: "AUTH_BACKEND_UNAVAILABLE",
    });
    return NextResponse.json({ error: "AUTH_UNAVAILABLE" }, { status: 503 });
  }
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const creds = getPlaidCreds();

  const { data: connections, error } = await supabase
    .from("fund_connections")
    .select("id, institution, status, updated_at, authority, action_required")
    .eq("user_id", user.id)
    .eq("provider", "plaid")
    .order("updated_at", { ascending: false })
    .limit(17);
  if (error) {
    captureRouteError(error, {
      route: "/api/plaid/status",
      operation: "read_connection_status",
      area: "fund",
      provider: "supabase",
      status: 500,
    });
    return NextResponse.json({ error: "STATUS_UNAVAILABLE", message: "Could not read Plaid connection status." }, { status: 503 });
  }

  const activeConnections = (connections ?? []).filter((connection) =>
    connection.status !== "revoked",
  );
  const linkedConnections = activeConnections.filter((connection) =>
    connection.status === "linked" && connection.authority === "provider_verified",
  );
  const validLinked = activeConnections.length === 1
    && linkedConnections.length === 1
    && (
      linkedConnections[0].action_required === null
      || linkedConnections[0].action_required === undefined
    );
  const reconnectRequired = activeConnections.length > 0 && !validLinked;
  if (activeConnections.length > 16) {
    captureRouteError(new Error("Plaid single-Item invariant failed"), {
      route: "/api/plaid/status", operation: "validate_single_item", area: "fund",
      provider: "supabase", status: 503, code: "PLAID_SINGLE_ITEM_INVARIANT_FAILED",
    });
    return NextResponse.json({ error: "STATUS_UNAVAILABLE" }, { status: 503 });
  }
  const connection = activeConnections[0] ?? null;

  return NextResponse.json({
    configured: !!creds,
    linked: validLinked,
    reconnectRequired,
    connectionCount: validLinked ? 1 : 0,
    recoveryMode: reconnectRequired
      ? activeConnections.length > 1
        ? "disconnect_all_then_relink"
        : "disconnect_then_relink"
      : null,
    recoveryConnections: reconnectRequired
      ? activeConnections.map((item) => ({
          id: item.id,
          institution: item.institution,
          status: item.status,
          actionRequired: item.action_required,
        }))
      : [],
    connection: connection
      ? {
          institution: connection.institution,
          status: connection.status,
          actionRequired: connection.action_required,
          updatedAt: connection.updated_at,
        }
      : null,
    provider: "plaid",
    env: creds?.env ?? null,
    message: creds
      ? "Plaid is configured server-side."
      : "Add PLAID_CLIENT_ID and PLAID_SECRET to enable bank linking via Plaid.",
  });
}
