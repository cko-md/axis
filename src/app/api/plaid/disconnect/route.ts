import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";
import {
  admitPlaidMutation,
  getPlaidCreds,
  PLAID_API_VERSION,
  plaidHost,
  readBoundedPlaidBody,
  readBoundedPlaidJson,
} from "../_lib";
import { captureRouteError } from "@/lib/observability/captureRouteError";
import { timedProviderFetch } from "@/lib/observability/providerTiming";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 1_024;
const RATE_LIMIT = 5;

/** Disconnects provider authorization before atomically clearing local credentials. */
export async function POST(request: NextRequest) {
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
    captureRouteError(authError, {
      route: "/api/plaid/disconnect",
      operation: "authenticate",
      area: "fund",
      provider: "supabase",
      status: 503,
      code: "AUTH_BACKEND_UNAVAILABLE",
    });
    return NextResponse.json({ error: "AUTH_UNAVAILABLE" }, { status: 503 });
  }
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admission = await admitPlaidMutation(user.id, RATE_LIMIT, "axis:plaid-disconnect");
  if (admission === "unavailable") {
    return NextResponse.json({ error: "PLAID_DISCONNECT_ADMISSION_UNAVAILABLE" }, { status: 503 });
  }
  if (admission === "limited") {
    return NextResponse.json(
      { error: "PLAID_DISCONNECT_RATE_LIMITED" },
      { status: 429, headers: { "retry-after": "60", "cache-control": "private, no-store" } },
    );
  }

  const rawBody = await readBoundedPlaidBody(request, MAX_BODY_BYTES);
  if (rawBody === null) {
    return NextResponse.json({ error: "BODY_TOO_LARGE" }, { status: 413 });
  }
  let body: { connectionId?: unknown };
  try {
    body = JSON.parse(rawBody) as { connectionId?: unknown };
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  if (typeof body.connectionId !== "string" || !UUID.test(body.connectionId)) {
    return NextResponse.json({ error: "INVALID_CONNECTION_ID" }, { status: 400 });
  }

  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch {
    admin = null;
  }
  if (!admin) {
    return NextResponse.json({ error: "DISCONNECT_UNAVAILABLE" }, { status: 503 });
  }
  let connectionResult;
  try {
    connectionResult = await admin
      .from("fund_connections")
      .select("id, status, action_required, access_token_enc")
      .eq("id", body.connectionId)
      .eq("user_id", user.id)
      .eq("provider", "plaid")
      .maybeSingle();
  } catch {
    return NextResponse.json({ error: "DISCONNECT_UNAVAILABLE" }, { status: 503 });
  }
  const { data: connection, error: connectionError } = connectionResult;
  if (connectionError) {
    captureRouteError(new Error("Plaid disconnect connection lookup failed"), {
      route: "/api/plaid/disconnect",
      operation: "load_connection",
      area: "fund",
      provider: "supabase",
      status: 503,
    });
    return NextResponse.json({ error: "DISCONNECT_UNAVAILABLE" }, { status: 503 });
  }
  if (!connection) return NextResponse.json({ error: "CONNECTION_NOT_FOUND" }, { status: 404 });
  if (connection.status === "revoked" && !connection.access_token_enc) {
    return NextResponse.json({ ok: true, alreadyRevoked: true });
  }
  if (!connection.access_token_enc) {
    return NextResponse.json({ error: "CONNECTION_NOT_DISCONNECTABLE" }, { status: 409 });
  }

  const creds = getPlaidCreds();
  let accessToken: string | null;
  try {
    accessToken = decrypt(connection.access_token_enc);
  } catch {
    accessToken = null;
  }
  if (!creds || !accessToken) {
    return NextResponse.json({ error: "DISCONNECT_UNAVAILABLE" }, { status: 503 });
  }

  // Persist intent before contacting Plaid. If the provider succeeds and local
  // finalization later fails, this durable state is visible to status/recovery
  // and can be reconciled by a signed revocation webhook or an explicit retry.
  let pendingResult;
  try {
    pendingResult = await admin
      .from("fund_connections")
      .update({
        status: "error",
        action_required: "disconnect_pending",
        updated_at: new Date().toISOString(),
      })
      .eq("id", connection.id)
      .eq("user_id", user.id)
      .eq("provider", "plaid")
      .select("id")
      .maybeSingle();
  } catch {
    return NextResponse.json({ error: "DISCONNECT_UNAVAILABLE" }, { status: 503 });
  }
  if (pendingResult.error || !pendingResult.data) {
    captureRouteError(new Error("Plaid disconnect intent persistence failed"), {
      route: "/api/plaid/disconnect",
      operation: "persist_disconnect_intent",
      area: "fund",
      provider: "supabase",
      status: 503,
    });
    return NextResponse.json({ error: "DISCONNECT_UNAVAILABLE" }, { status: 503 });
  }

  let providerResponse: Response;
  try {
    providerResponse = await timedProviderFetch(
      `${plaidHost(creds.env)}/item/remove`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Plaid-Version": PLAID_API_VERSION },
        body: JSON.stringify({
          client_id: creds.clientId,
          secret: creds.secret,
          access_token: accessToken,
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(8_000),
      },
      {
        area: "fund",
        provider: "plaid",
        operation: "item_remove",
        timeoutMs: 8_000,
        slowMs: 2_000,
      },
    );
  } catch {
    return NextResponse.json({ error: "PLAID_DISCONNECT_FAILED" }, { status: 503 });
  }
  if (!providerResponse.ok) {
    await readBoundedPlaidJson(providerResponse, 4_096);
    return NextResponse.json(
      { error: providerResponse.status === 429 ? "PLAID_RATE_LIMITED" : "PLAID_DISCONNECT_FAILED" },
      {
        status: providerResponse.status === 429 ? 429 : 502,
        ...(providerResponse.status === 429
          ? { headers: { "retry-after": "60", "cache-control": "private, no-store" } }
          : { headers: { "cache-control": "private, no-store" } }),
      },
    );
  }
  const providerBody = await readBoundedPlaidJson(providerResponse, 4_096);
  if (!providerBody || typeof providerBody.request_id !== "string" || !providerBody.request_id) {
    return NextResponse.json({ error: "PLAID_DISCONNECT_FAILED" }, { status: 502 });
  }

  let revokeResult;
  try {
    revokeResult = await admin
      .from("fund_connections")
      .update({
        status: "revoked",
        authority: "legacy_unknown",
        verified_at: null,
        action_required: null,
        access_token_enc: null,
        refresh_token_enc: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", connection.id)
      .eq("user_id", user.id)
      .eq("provider", "plaid")
      .eq("action_required", "disconnect_pending")
      .select("id")
      .maybeSingle();
  } catch {
    return NextResponse.json({ error: "DISCONNECT_FINALIZATION_FAILED" }, { status: 503 });
  }
  const { data: revoked, error: revokeError } = revokeResult;
  if (revokeError || !revoked) {
    captureRouteError(new Error("Plaid disconnect local finalization failed"), {
      route: "/api/plaid/disconnect",
      operation: "finalize_disconnect",
      area: "fund",
      provider: "supabase",
      status: 503,
    });
    return NextResponse.json({ error: "DISCONNECT_FINALIZATION_FAILED" }, { status: 503 });
  }
  return NextResponse.json(
    { ok: true, alreadyRevoked: false },
    { headers: { "cache-control": "private, no-store" } },
  );
}
