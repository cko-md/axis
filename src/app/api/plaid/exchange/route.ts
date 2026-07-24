import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPlaidCreds, plaidHost } from "../_lib";
import {
  PlaidConnectionStoreUnavailableError,
  savePlaidConnection,
} from "@/lib/fund/plaidTokens";
import { captureRouteError } from "@/lib/observability/captureRouteError";
import { admit, ADMISSION_POLICIES } from "@/lib/admission";
import { readBoundedJson } from "@/lib/http/boundedJson";
import type { SupabaseClient } from "@supabase/supabase-js";

const ROUTE = "/api/plaid/exchange";
const MAX_REQUEST_BYTES = 8_192;
const MAX_PROVIDER_RESPONSE_BYTES = 8_192;
const MAX_PUBLIC_TOKEN_CHARS = 4_096;
const MAX_ACCESS_TOKEN_CHARS = 4_096;
const MAX_ITEM_ID_CHARS = 512;
const MAX_REQUEST_ID_CHARS = 512;
const MAX_INSTITUTION_CHARS = 200;
const PROVIDER_TIMEOUT_MS = 7_000;

function plainRecord(value: unknown): Record<string, unknown> | null {
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    ? value as Record<string, unknown>
    : null;
}

function boundedNonemptyString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= max ? normalized : null;
}

function observable503(operation: string, code: string) {
  const provider =
    operation === "authenticate"
      ? "supabase_auth"
      : operation === "admission"
        ? "upstash"
      : operation === "preflight_connection" || operation === "save_connection"
        ? "supabase"
        : "plaid";
  captureRouteError(new Error("Plaid credential operation unavailable"), {
    route: ROUTE,
    operation,
    area: "fund",
    provider,
    status: 503,
    code,
  });
  return NextResponse.json({ error: code }, { status: 503 });
}

function cleanupRequired() {
  captureRouteError(new Error("Plaid compensating Item removal required"), {
    route: ROUTE,
    operation: "compensate_item",
    area: "fund",
    provider: "plaid",
    status: 503,
    code: "PLAID_CLEANUP_REQUIRED",
  });
  return NextResponse.json(
    { error: "PLAID_CLEANUP_REQUIRED" },
    { status: 503 },
  );
}

async function removeIssuedPlaidItem(
  accessToken: string,
  creds: NonNullable<ReturnType<typeof getPlaidCreds>>,
): Promise<boolean> {
  let response: Response;
  try {
    response = await fetch(`${plaidHost(creds.env)}/item/remove`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Plaid-Version": "2020-09-14",
      },
      body: JSON.stringify({
        client_id: creds.clientId,
        secret: creds.secret,
        access_token: accessToken,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
  } catch {
    return false;
  }
  if (!response.ok) {
    await readBoundedJson(response, MAX_PROVIDER_RESPONSE_BYTES);
    return false;
  }
  const parsed = await readBoundedJson(
    response,
    MAX_PROVIDER_RESPONSE_BYTES,
  );
  if (!parsed.ok) return false;
  const body = plainRecord(parsed.value);
  return Boolean(
    body
    && boundedNonemptyString(body.request_id, MAX_REQUEST_ID_CHARS),
  );
}

async function reconcileLocalPlaidItem(
  admin: SupabaseClient,
  userId: string,
  itemId: string,
): Promise<boolean> {
  try {
    const { error: updateError } = await admin
      .from("fund_connections")
      .update({
        status: "revoked",
        authority: "legacy_unknown",
        verified_at: null,
        access_token_enc: null,
        refresh_token_enc: null,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId)
      .eq("provider", "plaid")
      .eq("item_id", itemId)
      .abortSignal(AbortSignal.timeout(PROVIDER_TIMEOUT_MS));
    if (updateError) return false;

    const { data, error } = await admin
      .from("fund_connections")
      .select(
        "status, authority, verified_at, access_token_enc, refresh_token_enc",
      )
      .eq("user_id", userId)
      .eq("provider", "plaid")
      .eq("item_id", itemId)
      .limit(2)
      .abortSignal(AbortSignal.timeout(PROVIDER_TIMEOUT_MS));
    return !error
      && Array.isArray(data)
      && data.length <= 1
      && data.every((row) =>
        row.status === "revoked"
        && row.authority === "legacy_unknown"
        && row.verified_at === null
        && row.access_token_enc === null
        && row.refresh_token_enc === null);
  } catch {
    return false;
  }
}

/**
 * Exchanges one authenticated user's Plaid public token. The flow admits only
 * one active Item per owner and compensates any provider credential created
 * before a local persistence failure, so no untracked authorization is left
 * active after a failed request.
 */
export async function POST(req: NextRequest) {
  let authResult: Awaited<
    ReturnType<
      Awaited<ReturnType<typeof createClient>>["auth"]["getUser"]
    >
  >;
  try {
    const supabase = await createClient();
    authResult = await supabase.auth.getUser();
  } catch {
    return observable503("authenticate", "AUTH_BACKEND_UNAVAILABLE");
  }
  if (authResult.error) {
    return observable503("authenticate", "AUTH_BACKEND_UNAVAILABLE");
  }
  const { user } = authResult.data;
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let admission;
  try {
    admission = await admit(user.id, {
      ...ADMISSION_POLICIES.financial,
      name: "plaid-exchange",
      limit: 5,
    });
  } catch {
    return observable503("admission", "ADMISSION_UNAVAILABLE");
  }
  if (admission.kind === "unavailable") {
    return NextResponse.json(
      { error: "ADMISSION_UNAVAILABLE" },
      { status: 503 },
    );
  }
  if (admission.kind === "limited") {
    return NextResponse.json(
      { error: "RATE_LIMITED" },
      {
        status: 429,
        headers: {
          "retry-after": String(admission.retryAfterSeconds),
        },
      },
    );
  }

  const parsed = await readBoundedJson(req, MAX_REQUEST_BYTES);
  if (!parsed.ok) {
    return NextResponse.json(
      { error: parsed.code },
      { status: parsed.status },
    );
  }
  const body = plainRecord(parsed.value);
  const bodyKeys = body ? Object.keys(body) : [];
  if (
    !body
    || !bodyKeys.includes("public_token")
    || bodyKeys.some((key) => !["public_token", "institution"].includes(key))
  ) {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  const publicToken = boundedNonemptyString(
    body.public_token,
    MAX_PUBLIC_TOKEN_CHARS,
  );
  const institution =
    body.institution === undefined || body.institution === null
      ? null
      : boundedNonemptyString(body.institution, MAX_INSTITUTION_CHARS);
  if (
    !publicToken
    || (
      body.institution !== undefined
      && body.institution !== null
      && institution === null
    )
  ) {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    admin = null;
  }
  if (!admin) {
    return observable503("preflight_connection", "CONNECTION_STORE_UNAVAILABLE");
  }
  let existingResult;
  try {
    existingResult = await admin
      .from("fund_connections")
      .select("id")
      .eq("user_id", user.id)
      .eq("provider", "plaid")
      .neq("status", "revoked")
      .limit(2)
      .abortSignal(AbortSignal.timeout(PROVIDER_TIMEOUT_MS));
  } catch {
    return observable503(
      "preflight_connection",
      "CONNECTION_STORE_UNAVAILABLE",
    );
  }
  const { data: existing, error: existingError } = existingResult;
  if (existingError || !Array.isArray(existing)) {
    return observable503("preflight_connection", "CONNECTION_STORE_UNAVAILABLE");
  }
  if (existing.length > 0) {
    return NextResponse.json({ error: "PLAID_ALREADY_LINKED" }, { status: 409 });
  }

  const creds = getPlaidCreds();
  if (!creds) {
    return NextResponse.json(
      { error: "PLAID_NOT_CONFIGURED" },
      { status: 503 },
    );
  }

  let exchangeResponse: Response;
  try {
    exchangeResponse = await fetch(
      `${plaidHost(creds.env)}/item/public_token/exchange`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Plaid-Version": "2020-09-14",
        },
        body: JSON.stringify({
          client_id: creds.clientId,
          secret: creds.secret,
          public_token: publicToken,
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      },
    );
  } catch {
    captureRouteError(new Error("Plaid token exchange failed"), {
      route: ROUTE,
      operation: "exchange_token",
      area: "fund",
      provider: "plaid",
      status: 502,
      code: "PLAID_EXCHANGE_FAILED",
    });
    return NextResponse.json(
      { error: "PLAID_EXCHANGE_FAILED" },
      { status: 502 },
    );
  }
  if (!exchangeResponse.ok) {
    await readBoundedJson(exchangeResponse, MAX_PROVIDER_RESPONSE_BYTES);
    captureRouteError(new Error("Plaid token exchange was rejected"), {
      route: ROUTE,
      operation: "exchange_token",
      area: "fund",
      provider: "plaid",
      status: 502,
      code: "PLAID_EXCHANGE_FAILED",
    });
    return NextResponse.json(
      { error: "PLAID_EXCHANGE_FAILED" },
      { status: 502 },
    );
  }

  const exchangeJson = await readBoundedJson(
    exchangeResponse,
    MAX_PROVIDER_RESPONSE_BYTES,
  );
  if (!exchangeJson.ok) {
    return cleanupRequired();
  }
  const exchangeBody = plainRecord(exchangeJson.value);
  const issuedAccessToken = boundedNonemptyString(
    exchangeBody?.access_token,
    MAX_ACCESS_TOKEN_CHARS,
  );
  const itemId = boundedNonemptyString(
    exchangeBody?.item_id,
    MAX_ITEM_ID_CHARS,
  );
  const requestId = boundedNonemptyString(
    exchangeBody?.request_id,
    MAX_REQUEST_ID_CHARS,
  );
  if (
    !exchangeBody
    || !issuedAccessToken
    || !itemId
    || !requestId
  ) {
    if (!issuedAccessToken) return cleanupRequired();
    if (!await removeIssuedPlaidItem(issuedAccessToken, creds)) {
      return cleanupRequired();
    }
    return NextResponse.json(
      { error: "PLAID_EXCHANGE_FAILED" },
      { status: 502 },
    );
  }

  let saved = false;
  let conflict = false;
  try {
    saved = await savePlaidConnection(
      user.id,
      issuedAccessToken,
      itemId,
      institution,
    );
  } catch (error) {
    conflict =
      error instanceof PlaidConnectionStoreUnavailableError
      && error.reason === "conflict";
  }
  if (!saved) {
    const [providerSafe, localSafe] = await Promise.all([
      removeIssuedPlaidItem(issuedAccessToken, creds),
      reconcileLocalPlaidItem(admin, user.id, itemId),
    ]);
    if (!providerSafe || !localSafe) return cleanupRequired();
    if (conflict) {
      return NextResponse.json(
        { error: "PLAID_ALREADY_LINKED" },
        { status: 409 },
      );
    }
    return observable503(
      "save_connection",
      "CONNECTION_STORE_UNAVAILABLE",
    );
  }

  return NextResponse.json({ ok: true });
}
