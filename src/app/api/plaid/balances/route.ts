import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  getPlaidCreds,
  PLAID_API_VERSION,
  plaidHost,
  readBoundedPlaidJson,
} from "../_lib";
import { getPlaidAccessConnections, type PlaidAccessConnection } from "@/lib/fund/plaidTokens";
import { logRouteTiming, timedProviderFetch } from "@/lib/observability/providerTiming";
import { captureRouteError } from "@/lib/observability/captureRouteError";
import { minorUnitsToDecimalString, strictExactMinorUnits } from "@/lib/fund/financialTruth";
import { admitPlaidRequest } from "@/lib/plaid/admission";

const BALANCE_DEADLINE_MS = 8_000;
const BALANCE_CONCURRENCY = 4;

type PlaidAccount = {
  account_id?: string;
  persistent_account_id?: string | null;
  name: string;
  mask?: string;
  subtype?: string;
  type?: string;
  balances?: { current?: unknown; available?: unknown; iso_currency_code?: string | null };
};

async function fetchConnectionBalances(
  connection: PlaidAccessConnection,
  creds: NonNullable<ReturnType<typeof getPlaidCreds>>,
  signal: AbortSignal,
) {
  const res = await timedProviderFetch(
    `${plaidHost(creds.env)}/accounts/balance/get`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "Plaid-Version": PLAID_API_VERSION },
      body: JSON.stringify({
        client_id: creds.clientId,
        secret: creds.secret,
        access_token: connection.accessToken,
      }),
      cache: "no-store",
      signal,
    },
    { area: "fund", provider: "plaid", operation: "balances", timeoutMs: 7_000, slowMs: 2_000 },
  );
  if (!res.ok) {
    await readBoundedPlaidJson(res, 8_192);
    throw new Error("PLAID_BALANCES_REJECTED");
  }
  const data = await readBoundedPlaidJson(res, 128_000);
  if (!data || !Array.isArray(data.accounts) || data.accounts.length > 64) {
    throw new Error("PLAID_BALANCES_INVALID");
  }
  return (data.accounts as PlaidAccount[]).map((account) => {
    if (
      !account
      || typeof account !== "object"
      || typeof account.name !== "string"
      || account.name.length > 200
      || (account.account_id !== undefined && (typeof account.account_id !== "string" || account.account_id.length > 256))
      || (account.persistent_account_id !== undefined && account.persistent_account_id !== null
        && (typeof account.persistent_account_id !== "string" || account.persistent_account_id.length > 256))
    ) throw new Error("PLAID_BALANCES_INVALID");
    const currency = account.balances?.iso_currency_code ?? null;
    const currentMinor = currency ? strictExactMinorUnits(account.balances?.current, currency) : null;
    const availableMinor = currency ? strictExactMinorUnits(account.balances?.available, currency) : null;
    return {
      connectionId: connection.id,
      institution: connection.institution,
      persistentAccountId: typeof account.persistent_account_id === "string"
        ? account.persistent_account_id
        : null,
      name: account.name,
      mask: account.mask ?? null,
      subtype: account.subtype ?? null,
      type: account.type ?? null,
      current: currentMinor === null || !currency ? null : minorUnitsToDecimalString(currentMinor, currency),
      currentMinor,
      available: availableMinor === null || !currency ? null : minorUnitsToDecimalString(availableMinor, currency),
      availableMinor,
      currency,
    };
  });
}

/**
 * Fetches account balances for the authenticated user's linked Plaid item.
 *
 * Without keys: returns { configured: false } (200) so the Cash panel renders
 * a calm "connect a bank" empty-state rather than throwing.
 *
 * With keys: looks up the access_token from the server-side Supabase record
 * keyed by the authenticated user.id — the client never supplies it.
 */
export async function POST() {
  const routeStartedAt = Date.now();
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
    captureRouteError(new Error("Plaid balances authentication unavailable"), {
      route: "/api/plaid/balances", operation: "authenticate", area: "fund",
      provider: "supabase", status: 503, code: "AUTH_BACKEND_UNAVAILABLE",
    });
    return NextResponse.json({ error: "AUTH_UNAVAILABLE" }, { status: 503 });
  }
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const creds = getPlaidCreds();
  if (!creds) {
    logRouteTiming("/api/plaid/balances", routeStartedAt, { configured: false });
    return NextResponse.json({
      configured: false,
      accounts: [],
      message:
        "Add PLAID_CLIENT_ID and PLAID_SECRET to pull live bank balances.",
    });
  }
  const admission = await admitPlaidRequest(user.id, 30, 1_000, "axis:plaid-read:balances");
  if (admission !== "allowed") {
    return NextResponse.json(
      {
        configured: true,
        completeness: "unavailable",
        error: admission === "limited"
          ? "PLAID_BALANCES_RATE_LIMITED"
          : "PLAID_BALANCES_ADMISSION_UNAVAILABLE",
      },
      {
        status: admission === "limited" ? 429 : 503,
        ...(admission === "limited" ? { headers: { "retry-after": "60" } } : {}),
      },
    );
  }

  // Retrieve the single verified server-side token. The client never supplies
  // credentials, and a corrupt or duplicate store state fails closed.
  let connections: PlaidAccessConnection[];
  try {
    connections = await getPlaidAccessConnections(user.id);
  } catch {
    return NextResponse.json(
      { configured: true, completeness: "unavailable", error: "PLAID_CREDENTIAL_STORE_UNAVAILABLE" },
      { status: 503 },
    );
  }
  if (connections.length === 0) {
    return NextResponse.json(
      { configured: true, error: "NO_LINKED_ACCOUNT" },
      { status: 400 },
    );
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BALANCE_DEADLINE_MS);
    const accounts: Awaited<ReturnType<typeof fetchConnectionBalances>> = [];
    const failures: string[] = [];
    try {
      for (let start = 0; start < connections.length; start += BALANCE_CONCURRENCY) {
        const batch = connections.slice(start, start + BALANCE_CONCURRENCY);
        const results = await Promise.allSettled(
          batch.map((connection) => fetchConnectionBalances(connection, creds, controller.signal)),
        );
        results.forEach((result, index) => {
          if (result.status === "fulfilled") accounts.push(...result.value);
          else failures.push(batch[index].id);
        });
        if (controller.signal.aborted) {
          failures.push(...connections.slice(start + batch.length).map((connection) => connection.id));
          break;
        }
      }
    } finally {
      clearTimeout(timer);
    }
    if (failures.length > 0) {
      logRouteTiming("/api/plaid/balances", routeStartedAt, { ok: false });
      return NextResponse.json({
        configured: true,
        completeness: accounts.length > 0 ? "partial" : "unavailable",
        accounts,
        failedConnectionIds: [...new Set(failures)],
        error: accounts.length > 0 ? "PLAID_BALANCES_PARTIAL" : "PLAID_BALANCES_FAILED",
      }, { status: 502 });
    }
    const responseAccounts = accounts.map(({ persistentAccountId: _identity, ...account }) => account);
    logRouteTiming("/api/plaid/balances", routeStartedAt, { ok: true, accounts: accounts.length });
    return NextResponse.json({
      configured: true,
      completeness: "complete",
      verifiedEmpty: responseAccounts.length === 0,
      connectionCount: connections.length,
      accounts: responseAccounts,
    });
  } catch {
    logRouteTiming("/api/plaid/balances", routeStartedAt, { ok: false });
    return NextResponse.json(
      { configured: true, error: "PLAID_BALANCES_FAILED" },
      { status: 502 },
    );
  }
}
