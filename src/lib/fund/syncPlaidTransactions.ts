import type { SupabaseClient } from "@supabase/supabase-js";
import { getPlaidCreds, plaidHost } from "@/app/api/plaid/_lib";

type PlaidTxn = {
  transaction_id: string;
  account_id: string;
  name: string;
  merchant_name?: string;
  amount: number;
  date: string;
  authorized_date?: string;
  personal_finance_category?: { primary: string };
  pending?: boolean;
};

/**
 * Pulls the last 30 days of Plaid transactions for one item and upserts
 * them into fund_bank_transactions (dedup key: user_id + plaid_transaction_id
 * — decision #8). Used by both the Plaid webhook (single item, event-driven)
 * and the finance-daily cron (all items, nightly safety net).
 */
export async function syncPlaidTransactions(
  admin: SupabaseClient,
  userId: string,
  connectionId: string,
  accessToken: string,
): Promise<{ synced: number } | { error: string }> {
  const creds = getPlaidCreds();
  if (!creds) return { error: "PLAID_NOT_CONFIGURED" };

  const now = new Date();
  const since = new Date(now.getTime() - 30 * 86400000);

  const res = await fetch(`${plaidHost(creds.env)}/transactions/get`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: creds.clientId,
      secret: creds.secret,
      access_token: accessToken,
      start_date: since.toISOString().slice(0, 10),
      end_date: now.toISOString().slice(0, 10),
      options: { count: 250, offset: 0 },
    }),
  });
  if (!res.ok) return { error: "PLAID_TXN_FETCH_FAILED" };

  const data = await res.json();
  const transactions = (data.transactions ?? []) as PlaidTxn[];
  if (!transactions.length) return { synced: 0 };

  const rows = transactions.map((t) => ({
    user_id: userId,
    connection_id: connectionId,
    plaid_transaction_id: t.transaction_id,
    account_id: t.account_id,
    merchant_name: t.merchant_name ?? t.name,
    raw_name: t.name,
    amount: -t.amount, // Plaid: positive = debit; flip so positive = inflow (matches existing convention)
    plaid_category: t.personal_finance_category?.primary ?? "OTHER",
    posted_date: t.date,
    authorized_date: t.authorized_date ?? null,
    pending: t.pending ?? false,
  }));

  const { error } = await admin
    .from("fund_bank_transactions")
    .upsert(rows, { onConflict: "user_id,plaid_transaction_id" });

  if (error) return { error: error.message };

  await tagTransfers(admin, userId);
  return { synced: rows.length };
}

/**
 * Deterministic transfer detection (decision #8): opposite-signed,
 * matching-amount transactions on two different accounts within a 2-day
 * window are tagged as transfers and excluded from spend/income totals.
 * Never an AI judgment call.
 */
async function tagTransfers(admin: SupabaseClient, userId: string) {
  const since = new Date(Date.now() - 35 * 86400000).toISOString().slice(0, 10);
  const { data: txns } = await admin
    .from("fund_bank_transactions")
    .select("id, account_id, amount, posted_date, is_transfer")
    .eq("user_id", userId)
    .gte("posted_date", since);

  if (!txns || txns.length < 2) return;

  const toTag = new Set<string>();
  for (let i = 0; i < txns.length; i++) {
    const a = txns[i];
    if (a.is_transfer || toTag.has(a.id)) continue;
    for (let j = i + 1; j < txns.length; j++) {
      const b = txns[j];
      if (b.is_transfer || toTag.has(b.id) || a.account_id === b.account_id) continue;
      const sameMagnitude = Math.abs(Math.abs(a.amount) - Math.abs(b.amount)) < 0.01;
      const oppositeSign = a.amount !== 0 && Math.sign(a.amount) !== Math.sign(b.amount);
      const daysApart =
        Math.abs(new Date(a.posted_date).getTime() - new Date(b.posted_date).getTime()) / 86400000;
      if (sameMagnitude && oppositeSign && daysApart <= 2) {
        toTag.add(a.id);
        toTag.add(b.id);
        break;
      }
    }
  }

  if (toTag.size > 0) {
    await admin.from("fund_bank_transactions").update({ is_transfer: true }).in("id", [...toTag]);
  }
}
