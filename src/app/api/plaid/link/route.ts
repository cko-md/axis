import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  admitPlaidMutation,
  getPlaidCreds,
  PLAID_API_VERSION,
  plaidHost,
  readBoundedPlaidJson,
} from "../_lib";
import { captureRouteError } from "@/lib/observability/captureRouteError";
import { timedProviderFetch } from "@/lib/observability/providerTiming";

const RATE_LIMIT = 10;
const TOKEN = /^[A-Za-z0-9_-]{1,512}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T/;

/** Creates one bounded Plaid Link session under the single-Item contract. */
export async function POST() {
  let supabase: Awaited<ReturnType<typeof createClient>>;
  try {
    supabase = await createClient();
  } catch {
    return NextResponse.json({ error: "AUTH_UNAVAILABLE" }, { status: 503 });
  }
  let authResult: Awaited<ReturnType<typeof supabase.auth.getUser>>;
  try {
    authResult = await supabase.auth.getUser();
  } catch {
    return NextResponse.json({ error: "AUTH_UNAVAILABLE" }, { status: 503 });
  }
  const { data: { user }, error: authError } = authResult;
  if (authError) {
    captureRouteError(new Error("Plaid Link authentication unavailable"), {
      route: "/api/plaid/link",
      operation: "authenticate",
      area: "fund",
      provider: "supabase",
      status: 503,
      code: "AUTH_BACKEND_UNAVAILABLE",
    });
    return NextResponse.json({ error: "AUTH_UNAVAILABLE" }, { status: 503 });
  }
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const admission = await admitPlaidMutation(user.id, RATE_LIMIT, "axis:plaid-link");
  if (admission === "unavailable") {
    return NextResponse.json({ error: "PLAID_LINK_ADMISSION_UNAVAILABLE" }, { status: 503 });
  }
  if (admission === "limited") {
    return NextResponse.json(
      { error: "PLAID_LINK_RATE_LIMITED" },
      { status: 429, headers: { "retry-after": "60" } },
    );
  }

  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch {
    admin = null;
  }
  if (!admin) {
    return NextResponse.json({ error: "PLAID_LINK_UNAVAILABLE" }, { status: 503 });
  }
  let existingResult: {
    data: Array<{ id: string }> | null;
    error: unknown;
  };
  try {
    existingResult = await admin
      .from("fund_connections")
      .select("id")
      .eq("user_id", user.id)
      .eq("provider", "plaid")
      .neq("status", "revoked")
      .limit(2);
  } catch {
    return NextResponse.json({ error: "PLAID_LINK_UNAVAILABLE" }, { status: 503 });
  }
  const { data: existing, error: existingError } = existingResult;
  if (existingError || (existing ?? []).length > 1) {
    captureRouteError(new Error("Plaid Link preflight unavailable"), {
      route: "/api/plaid/link",
      operation: "load_existing_connection",
      area: "fund",
      provider: "supabase",
      status: 503,
    });
    return NextResponse.json({ error: "PLAID_LINK_UNAVAILABLE" }, { status: 503 });
  }
  if ((existing ?? []).length === 1) {
    return NextResponse.json({ error: "PLAID_SINGLE_ITEM_LIMIT" }, { status: 409 });
  }

  const creds = getPlaidCreds();
  if (!creds) {
    return NextResponse.json({ configured: false, error: "PLAID_NOT_CONFIGURED" }, { status: 503 });
  }

  let response: Response;
  try {
    response = await timedProviderFetch(
      `${plaidHost(creds.env)}/link/token/create`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Plaid-Version": PLAID_API_VERSION },
        body: JSON.stringify({
          client_id: creds.clientId,
          secret: creds.secret,
          client_name: "Axis · Fund",
          language: "en",
          country_codes: ["US"],
          user: { client_user_id: user.id },
          products: ["transactions"],
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(8_000),
      },
      {
        area: "fund",
        provider: "plaid",
        operation: "link_token_create",
        timeoutMs: 8_000,
        slowMs: 2_000,
      },
    );
  } catch {
    return NextResponse.json({ configured: true, error: "PLAID_LINK_FAILED" }, { status: 503 });
  }
  if (!response.ok) {
    await readBoundedPlaidJson(response, 8_192);
    return NextResponse.json(
      { configured: true, error: response.status === 429 ? "PLAID_RATE_LIMITED" : "PLAID_LINK_FAILED" },
      { status: response.status === 429 ? 429 : 502 },
    );
  }
  const data = await readBoundedPlaidJson(response, 8_192);
  const expirationMs = typeof data?.expiration === "string"
    ? Date.parse(data.expiration)
    : Number.NaN;
  if (
    !data
    || typeof data.link_token !== "string"
    || !TOKEN.test(data.link_token)
    || typeof data.expiration !== "string"
    || data.expiration.length > 64
    || !ISO_INSTANT.test(data.expiration)
    || !Number.isFinite(expirationMs)
    || expirationMs <= Date.now()
    || expirationMs > Date.now() + 24 * 60 * 60 * 1_000
    || typeof data.request_id !== "string"
    || !TOKEN.test(data.request_id)
  ) {
    return NextResponse.json({ configured: true, error: "PLAID_LINK_FAILED" }, { status: 502 });
  }
  return NextResponse.json({
    configured: true,
    link_token: data.link_token,
    expiration: data.expiration,
  });
}
