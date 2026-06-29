import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getBrokerageCreds } from "../_lib";
import { logRouteTiming, timedProviderFetch } from "@/lib/observability/providerTiming";

const PUBLIC_API_BASE = "https://api.public.com";

/**
 * GET /api/brokerage/accounts
 *
 * Fetches the list of accounts associated with the configured Public.com PAT.
 * Use the returned account `id` as APP_PUBLIC_ACCOUNT_ID in Vercel env vars.
 *
 * Returns { configured: false } when APP_PUBLIC_API_KEY is not set.
 */
export async function GET() {
  const routeStartedAt = Date.now();
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const creds = getBrokerageCreds();
  if (!creds) {
    logRouteTiming("/api/brokerage/accounts", routeStartedAt, { configured: false });
    return NextResponse.json(
      { configured: false, error: "APP_PUBLIC_API_KEY not set in environment." },
      { status: 503 },
    );
  }

  try {
    const res = await timedProviderFetch(`${PUBLIC_API_BASE}/accounts`, {
      headers: {
        Authorization: `Bearer ${creds.apiKey}`,
        Accept: "application/json",
      },
      next: { revalidate: 0 },
    }, { area: "fund", provider: "public", operation: "accounts", timeoutMs: 7_000, slowMs: 2_000 });

    if (!res.ok) {
      logRouteTiming("/api/brokerage/accounts", routeStartedAt, { configured: true, ok: false, status: res.status });
      return NextResponse.json(
        { configured: true, error: "ACCOUNTS_FETCH_FAILED", status: res.status },
        { status: 502 },
      );
    }

    const data = await res.json();
    // Public.com may return { accounts: [...] } or an array directly
    const accounts = Array.isArray(data) ? data : (data.accounts ?? data.data ?? []);
    logRouteTiming("/api/brokerage/accounts", routeStartedAt, { configured: true, ok: true, accounts: accounts.length });

    return NextResponse.json({
      configured: true,
      accounts: accounts.map((a: Record<string, unknown>) => ({
        id: a.id ?? a.account_id ?? a.accountId,
        type: a.type ?? a.account_type ?? a.accountType,
        name: a.name ?? a.display_name ?? a.nickname,
        status: a.status,
        currency: a.currency ?? "USD",
      })),
      hint: "Set APP_PUBLIC_ACCOUNT_ID in Vercel to the `id` of the account you want to trade with.",
    });
  } catch {
    logRouteTiming("/api/brokerage/accounts", routeStartedAt, { configured: true, ok: false });
    return NextResponse.json({ configured: true, error: "NETWORK_ERROR" }, { status: 502 });
  }
}
