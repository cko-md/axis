import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getPlaidCreds, plaidHost } from "../_lib";
import { getPlaidAccessToken } from "@/lib/fund/plaidTokens";

export async function POST() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const creds = getPlaidCreds();
  if (!creds) {
    return NextResponse.json({ configured: false, transactions: [] });
  }

  const accessToken = await getPlaidAccessToken(user.id);

  if (!accessToken) {
    return NextResponse.json({ configured: true, error: "NO_LINKED_ACCOUNT" }, { status: 400 });
  }

  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  try {
    const res = await fetch(`${plaidHost(creds.env)}/transactions/get`, {
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
    });

    if (!res.ok) {
      const detail = await res.text();
      console.error("[plaid/transactions] upstream error:", detail);
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

    return NextResponse.json({ configured: true, transactions });
  } catch {
    return NextResponse.json({ configured: true, error: "PLAID_TXN_FAILED" }, { status: 502 });
  }
}
