import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getPlaidCreds, plaidHost } from "../_lib";
import { getPlaidAccessToken } from "@/lib/fund/plaidTokens";
import { logRouteTiming, timedProviderFetch } from "@/lib/observability/providerTiming";

export async function POST() {
  const routeStartedAt = Date.now();
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const creds = getPlaidCreds();
  if (!creds) {
    logRouteTiming("/api/plaid/transactions", routeStartedAt, { configured: false });
    return NextResponse.json({ configured: false, transactions: [] });
  }

  const accessToken = await getPlaidAccessToken(user.id);

  if (!accessToken) {
    return NextResponse.json({ configured: true, error: "NO_LINKED_ACCOUNT" }, { status: 400 });
  }

  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  try {
    const res = await timedProviderFetch(
      `${plaidHost(creds.env)}/transactions/get`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: creds.clientId,
          secret: creds.secret,
          access_token: accessToken,
          start_date: thirtyDaysAgo.toISOString().slice(0, 10),
          end_date: now.toISOString().slice(0, 10),
          options: { count: 50, offset: 0 },
        }),
        cache: "no-store",
      },
      { area: "fund", provider: "plaid", operation: "transactions", timeoutMs: 8_000, slowMs: 2_000 },
    );

    if (!res.ok) {
      logRouteTiming("/api/plaid/transactions", routeStartedAt, { ok: false, status: res.status });
      return NextResponse.json({ configured: true, error: "PLAID_TXN_FAILED" }, { status: 502 });
    }

    const data = await res.json();
    const transactions = (data.transactions ?? []).map(
      (t: {
        transaction_id: string;
        name: string;
        merchant_name?: string;
        amount: number;
        date: string;
        personal_finance_category?: { primary: string };
        payment_channel?: string;
        pending?: boolean;
      }) => ({
        id: t.transaction_id,
        name: t.merchant_name ?? t.name,
        category: t.personal_finance_category?.primary ?? "OTHER",
        // Plaid convention: positive amount = money leaving account (debit).
        // We flip so negative = money out, positive = money in.
        amount: -t.amount,
        date: t.date,
        channel: t.payment_channel ?? "other",
        pending: t.pending ?? false,
      }),
    );

    logRouteTiming("/api/plaid/transactions", routeStartedAt, { ok: true, transactions: transactions.length });
    return NextResponse.json({ configured: true, transactions });
  } catch {
    logRouteTiming("/api/plaid/transactions", routeStartedAt, { ok: false });
    return NextResponse.json({ configured: true, error: "PLAID_TXN_FAILED" }, { status: 502 });
  }
}
