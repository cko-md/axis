import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  admitPlaidMutation,
  getPlaidCreds,
  PLAID_API_VERSION,
  plaidHost,
  readBoundedPlaidBody,
  readBoundedPlaidJson,
} from "../_lib";
import { savePlaidConnection } from "@/lib/fund/plaidTokens";
import { timedProviderFetch } from "@/lib/observability/providerTiming";
import { captureRouteError } from "@/lib/observability/captureRouteError";

const MAX_BODY_BYTES = 2_048;
const RATE_LIMIT = 10;
const TOKEN = /^[A-Za-z0-9_-]{1,512}$/;

async function removeItem(
  creds: NonNullable<ReturnType<typeof getPlaidCreds>>,
  accessToken: string,
): Promise<boolean> {
  try {
    const response = await timedProviderFetch(
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
        operation: "orphan_item_remove",
        timeoutMs: 8_000,
        slowMs: 2_000,
      },
    );
    if (!response.ok) {
      await readBoundedPlaidJson(response, 4_096);
      return false;
    }
    const body = await readBoundedPlaidJson(response, 4_096);
    return Boolean(body && typeof body.request_id === "string" && body.request_id);
  } catch {
    return false;
  }
}

/** Exchanges a public token while enforcing the current single-verified-Item contract. */
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
      route: "/api/plaid/exchange",
      operation: "authenticate",
      area: "fund",
      provider: "supabase",
      status: 503,
      code: "AUTH_BACKEND_UNAVAILABLE",
    });
    return NextResponse.json({ error: "AUTH_UNAVAILABLE" }, { status: 503 });
  }
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const admission = await admitPlaidMutation(user.id, RATE_LIMIT, "axis:plaid-exchange");
  if (admission === "unavailable") {
    return NextResponse.json({ error: "PLAID_LINK_ADMISSION_UNAVAILABLE" }, { status: 503 });
  }
  if (admission === "limited") {
    return NextResponse.json(
      { error: "PLAID_LINK_RATE_LIMITED" },
      { status: 429, headers: { "retry-after": "60" } },
    );
  }

  const raw = await readBoundedPlaidBody(request, MAX_BODY_BYTES);
  if (raw === null) {
    return NextResponse.json({ error: "BODY_TOO_LARGE" }, { status: 413 });
  }
  let body: { public_token?: unknown; institution?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  if (
    typeof body.public_token !== "string"
    || !TOKEN.test(body.public_token)
    || (
      body.institution !== undefined
      && body.institution !== null
      && (typeof body.institution !== "string" || body.institution.length > 200)
    )
  ) {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }

  const creds = getPlaidCreds();
  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch {
    admin = null;
  }
  if (!creds || !admin) {
    return NextResponse.json({ error: "PLAID_LINK_UNAVAILABLE" }, { status: 503 });
  }
  const { data: existing, error: existingError } = await admin
    .from("fund_connections")
    .select("id, item_id")
    .eq("user_id", user.id)
    .eq("provider", "plaid")
    .neq("status", "revoked")
    .limit(2);
  if (existingError || (existing ?? []).length > 1) {
    captureRouteError(new Error("Plaid connection preflight unavailable"), {
      route: "/api/plaid/exchange",
      operation: "load_existing_connections",
      area: "fund",
      provider: "supabase",
      status: 503,
    });
    return NextResponse.json({ error: "PLAID_LINK_UNAVAILABLE" }, { status: 503 });
  }
  if ((existing ?? []).length === 1) {
    return NextResponse.json({ error: "PLAID_SINGLE_ITEM_LIMIT" }, { status: 409 });
  }

  let exchangeResponse: Response;
  try {
    exchangeResponse = await timedProviderFetch(
      `${plaidHost(creds.env)}/item/public_token/exchange`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Plaid-Version": PLAID_API_VERSION },
        body: JSON.stringify({
          client_id: creds.clientId,
          secret: creds.secret,
          public_token: body.public_token,
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(8_000),
      },
      {
        area: "fund",
        provider: "plaid",
        operation: "public_token_exchange",
        timeoutMs: 8_000,
        slowMs: 2_000,
      },
    );
  } catch {
    return NextResponse.json({ error: "PLAID_LINK_FAILED" }, { status: 503 });
  }
  if (!exchangeResponse.ok) {
    await readBoundedPlaidJson(exchangeResponse, 8_192);
    return NextResponse.json(
      { error: exchangeResponse.status === 429 ? "PLAID_RATE_LIMITED" : "PLAID_LINK_FAILED" },
      { status: exchangeResponse.status === 429 ? 429 : 502 },
    );
  }
  const plaidData = await readBoundedPlaidJson(exchangeResponse, 8_192);
  if (
    !plaidData
    || typeof plaidData.access_token !== "string"
    || !TOKEN.test(plaidData.access_token)
    || typeof plaidData.item_id !== "string"
    || !TOKEN.test(plaidData.item_id)
    || typeof plaidData.request_id !== "string"
    || !plaidData.request_id
  ) {
    return NextResponse.json({ error: "PLAID_LINK_FAILED" }, { status: 502 });
  }

  const saved = await savePlaidConnection(
    user.id,
    plaidData.access_token,
    plaidData.item_id,
    typeof body.institution === "string" ? body.institution : null,
  );
  if (!saved) {
    const cleaned = await removeItem(creds, plaidData.access_token);
    if (!cleaned) {
      captureRouteError(new Error("Plaid failed-link cleanup failed"), {
        route: "/api/plaid/exchange",
        operation: "cleanup_failed_link",
        area: "fund",
        provider: "plaid",
        status: 503,
      });
      return NextResponse.json({ error: "PLAID_CLEANUP_REQUIRED" }, { status: 503 });
    }
    const { data: ambiguousRow, error: ambiguousError } = await admin
      .from("fund_connections")
      .select("id, status")
      .eq("user_id", user.id)
      .eq("provider", "plaid")
      .eq("item_id", plaidData.item_id)
      .maybeSingle();
    if (ambiguousError) {
      captureRouteError(new Error("Plaid cleanup state lookup failed"), {
        route: "/api/plaid/exchange",
        operation: "prove_failed_link_cleanup",
        area: "fund",
        provider: "supabase",
        status: 503,
      });
      return NextResponse.json({ error: "PLAID_CLEANUP_REQUIRED" }, { status: 503 });
    }
    if (ambiguousRow && ambiguousRow.status !== "revoked") {
      const { data: revoked, error: revokeError } = await admin
        .from("fund_connections")
        .update({
          status: "revoked",
          authority: "legacy_unknown",
          verified_at: null,
          access_token_enc: null,
          refresh_token_enc: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", ambiguousRow.id)
        .eq("user_id", user.id)
        .eq("provider", "plaid")
        .eq("item_id", plaidData.item_id)
        .neq("status", "revoked")
        .select("id")
        .maybeSingle();
      if (revokeError || !revoked) {
        captureRouteError(new Error("Plaid cleanup local revocation failed"), {
          route: "/api/plaid/exchange",
          operation: "finalize_failed_link_cleanup",
          area: "fund",
          provider: "supabase",
          status: 503,
        });
        return NextResponse.json({ error: "PLAID_CLEANUP_REQUIRED" }, { status: 503 });
      }
    }
    return NextResponse.json({ error: "PLAID_LINK_SAVE_FAILED" }, { status: 502 });
  }
  return NextResponse.json({ ok: true });
}
