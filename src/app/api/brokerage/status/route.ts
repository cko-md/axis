import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getBrokerageCreds } from "../_lib";
import { captureRouteError } from "@/lib/observability/captureRouteError";
import { resolveRouteIdentity } from "@/lib/auth/routeIdentity";
import { EXPECTED_PROFILE_SUBJECT_HEADER } from "@/lib/auth/profileSubject";
import { profileSubjectForUserId } from "@/lib/auth/profileSubject.server";

/**
 * Brokerage (Public.com) connectivity status. Generic scaffold behind a
 * setup-state, matching /api/massive/status and /api/plaid/status. Returns
 * { configured: false } with no error when keys are absent. Connectivity never
 * implies that live submission is enabled; this phase stores intents only.
 */

export async function GET(request: NextRequest) {
  const identity = await resolveRouteIdentity(createClient, {
    route: "/api/brokerage/status",
    area: "fund",
  });
  if (!identity.ok) {
    return NextResponse.json(
      { error: identity.status === 401 ? "Unauthorized" : identity.code },
      { status: identity.status },
    );
  }
  const { client: supabase, user } = identity;
  const expectedSubject = request.headers.get(EXPECTED_PROFILE_SUBJECT_HEADER);
  if (expectedSubject && expectedSubject !== profileSubjectForUserId(user.id)) {
    return NextResponse.json({ error: "SUBJECT_CHANGED" }, { status: 409 });
  }

  const creds = getBrokerageCreds();
  const { data: connections, error } = await supabase
    .from("fund_connections")
    .select("institution, status, updated_at, authority")
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

  const linkedConnections = (connections ?? []).filter((connection) =>
    connection.status === "linked" && connection.authority === "provider_verified",
  );
  const reconnectRequired = (connections ?? []).some((connection) =>
    connection.status === "linked" && connection.authority === "legacy_unknown",
  );
  const latestConnection = connections?.[0] ?? null;

  return NextResponse.json({
    configured: !!creds,
    linked: linkedConnections.length > 0,
    reconnectRequired,
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
      ? "Public.com credentials are configured. Live order submission remains disabled."
      : "Public.com credentials are not configured. Order intents can still be saved for review; no order is submitted.",
  });
}
