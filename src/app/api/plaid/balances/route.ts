import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getPlaidCreds, plaidHost } from "../_lib";
import { getPlaidAccessToken } from "@/lib/fund/plaidTokens";
import { logRouteTiming, timedProviderFetch } from "@/lib/observability/providerTiming";

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
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

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

  // Retrieve the stored access_token from the server-side record for this user.
  // The client must never supply the token directly.
  const accessToken = await getPlaidAccessToken(user.id);

  if (!accessToken) {
    return NextResponse.json(
      { configured: true, error: "NO_LINKED_ACCOUNT" },
      { status: 400 },
    );
  }

  try {
    const res = await timedProviderFetch(
      `${plaidHost(creds.env)}/accounts/balance/get`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: creds.clientId,
          secret: creds.secret,
          access_token: accessToken,
        }),
        cache: "no-store",
      },
      { area: "fund", provider: "plaid", operation: "balances", timeoutMs: 7_000, slowMs: 2_000 },
    );

    if (!res.ok) {
      logRouteTiming("/api/plaid/balances", routeStartedAt, { ok: false, status: res.status });
      return NextResponse.json(
        { configured: true, error: "PLAID_BALANCES_FAILED" },
        { status: 502 },
      );
    }

    const data = await res.json();
    const accounts = (data.accounts ?? []).map(
      (a: {
        name: string;
        mask?: string;
        subtype?: string;
        balances?: { current?: number; available?: number };
      }) => ({
        name: a.name,
        mask: a.mask ?? null,
        subtype: a.subtype ?? null,
        current: a.balances?.current ?? null,
        available: a.balances?.available ?? null,
      }),
    );
    logRouteTiming("/api/plaid/balances", routeStartedAt, { ok: true, accounts: accounts.length });
    return NextResponse.json({ configured: true, accounts });
  } catch {
    logRouteTiming("/api/plaid/balances", routeStartedAt, { ok: false });
    return NextResponse.json(
      { configured: true, error: "PLAID_BALANCES_FAILED" },
      { status: 502 },
    );
  }
}
