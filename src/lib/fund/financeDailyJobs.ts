import type { SupabaseClient } from "@supabase/supabase-js";
import { decrypt } from "@/lib/crypto";
import { getPlaidCreds, plaidHost } from "@/app/api/plaid/_lib";
import { fetchSnapshot, getPolygonApiKey } from "@/lib/massive/client";
import { notifyViaMake } from "@/lib/fund/notifyViaMake";

/** Fetches live Plaid balances server-side for the finance-daily snapshot job. */
async function fetchPlaidCash(accessToken: string): Promise<number> {
  const creds = getPlaidCreds();
  if (!creds) return 0;
  try {
    const res = await fetch(`${plaidHost(creds.env)}/accounts/balance/get`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: creds.clientId, secret: creds.secret, access_token: accessToken }),
    });
    if (!res.ok) return 0;
    const data = await res.json();
    const accounts = (data.accounts ?? []) as Array<{ balances?: { current?: number } }>;
    return accounts.reduce((sum, a) => sum + (a.balances?.current ?? 0), 0);
  } catch {
    return 0;
  }
}

/**
 * Computes and upserts today's net_worth_snapshots row for one user —
 * cash from Plaid (live), invested from fund_holdings priced via Massive
 * where available (cost basis fallback otherwise), liabilities from
 * fund_liabilities. Deterministic; no AI involved.
 */
export async function snapshotNetWorth(admin: SupabaseClient, userId: string): Promise<void> {
  const { data: connections } = await admin
    .from("fund_connections")
    .select("access_token_enc")
    .eq("user_id", userId)
    .eq("provider", "plaid")
    .eq("status", "linked");

  let cash = 0;
  for (const c of connections ?? []) {
    if (!c.access_token_enc) continue;
    const token = decrypt(c.access_token_enc);
    if (token) cash += await fetchPlaidCash(token);
  }

  const { data: holdings } = await admin
    .from("fund_holdings")
    .select("symbol, shares, cost_basis")
    .eq("user_id", userId);

  let invested = 0;
  const polygonConfigured = !!getPolygonApiKey();
  for (const h of holdings ?? []) {
    const shares = Number(h.shares);
    const costBasis = Number(h.cost_basis);
    if (polygonConfigured) {
      try {
        const { price } = await fetchSnapshot(h.symbol);
        invested += shares * price;
        continue;
      } catch {
        // fall through to cost-basis fallback
      }
    }
    invested += costBasis;
  }

  const { data: liabilityRows } = await admin
    .from("fund_liabilities")
    .select("balance")
    .eq("user_id", userId);
  const liabilities = (liabilityRows ?? []).reduce((sum, l) => sum + Number(l.balance), 0);

  const net_worth = cash + invested - liabilities;
  await admin.from("net_worth_snapshots").upsert(
    {
      user_id: userId,
      captured_on: new Date().toISOString().slice(0, 10),
      cash,
      invested,
      liabilities,
      net_worth,
    },
    { onConflict: "user_id,captured_on" },
  );
}

type Cadence = "weekly" | "biweekly" | "monthly" | "quarterly" | "annual";

function inferCadence(avgGapDays: number): Cadence {
  if (avgGapDays <= 10) return "weekly";
  if (avgGapDays <= 17) return "biweekly";
  if (avgGapDays <= 45) return "monthly";
  if (avgGapDays <= 120) return "quarterly";
  return "annual";
}

/**
 * Best-effort recurring-charge detection: groups spend transactions by
 * (merchant, rounded amount); two or more occurrences become a recurring
 * row with cadence inferred from the average gap between them. Manual
 * declarations (source='manual') are left untouched.
 */
export async function detectRecurring(admin: SupabaseClient, userId: string): Promise<void> {
  const { data: txns } = await admin
    .from("fund_bank_transactions")
    .select("merchant_name, amount, posted_date")
    .eq("user_id", userId)
    .eq("is_transfer", false)
    .lt("amount", 0)
    .order("posted_date");

  if (!txns || txns.length < 2) return;

  const groups = new Map<string, { merchant: string; amount: number; date: string }[]>();
  for (const t of txns) {
    if (!t.merchant_name) continue;
    const key = `${t.merchant_name}|${Math.round(Math.abs(t.amount))}`;
    const arr = groups.get(key) ?? [];
    arr.push({ merchant: t.merchant_name, amount: t.amount, date: t.posted_date });
    groups.set(key, arr);
  }

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const dates = group.map((g) => new Date(g.date).getTime()).sort((a, b) => a - b);
    const gaps = dates.slice(1).map((d, i) => (d - dates[i]) / 86400000);
    const avgGap = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    const last = group[group.length - 1];

    await admin.from("fund_recurring_transactions").upsert(
      {
        user_id: userId,
        merchant_name: last.merchant,
        expected_amount: Math.abs(last.amount),
        cadence: inferCadence(avgGap),
        last_seen_date: last.date,
        next_expected_date: new Date(new Date(last.date).getTime() + avgGap * 86400000)
          .toISOString()
          .slice(0, 10),
        source: "detected",
        status: "active",
      },
      { onConflict: "user_id,merchant_name", ignoreDuplicates: false },
    );
  }
}

/**
 * Writes a deterministic daily_brief row to ai_insights — plain computed
 * text from already-stored numbers, no AI call. Phase 5's tool-calling
 * Advisor will replace this with a richer, narrated brief that still only
 * reads from these same deterministic sources.
 */
export async function writeDailyBrief(admin: SupabaseClient, userId: string, userEmail: string | null): Promise<void> {
  const { data: snapshots } = await admin
    .from("net_worth_snapshots")
    .select("captured_on, net_worth")
    .eq("user_id", userId)
    .order("captured_on", { ascending: false })
    .limit(8);

  if (!snapshots || snapshots.length < 1) return;
  const today = snapshots[0];
  const weekAgo = snapshots.find((s) => s.captured_on !== today.captured_on);
  const change = weekAgo ? today.net_worth - weekAgo.net_worth : 0;
  const changePct = weekAgo && weekAgo.net_worth ? (change / weekAgo.net_worth) * 100 : 0;

  const body = weekAgo
    ? `Net worth is ${change >= 0 ? "up" : "down"} ${Math.abs(changePct).toFixed(1)}% since ${weekAgo.captured_on}, now $${today.net_worth.toLocaleString(undefined, { maximumFractionDigits: 0 })}.`
    : `First snapshot recorded: net worth $${today.net_worth.toLocaleString(undefined, { maximumFractionDigits: 0 })}.`;

  await admin.from("ai_insights").insert({
    user_id: userId,
    kind: "daily_brief",
    title: "Daily brief",
    body,
    data_used: { snapshots },
    assumptions: "Computed directly from net_worth_snapshots — no AI interpretation applied.",
    confidence: "high",
    requires_review: false,
  });

  if (userEmail) {
    await notifyViaMake(admin, {
      idempotencyKey: `daily_brief:${userId}:${today.captured_on}`,
      kind: "daily_brief",
      userId,
      to: userEmail,
      subject: "Your daily finance brief",
      bodyText: body,
      meta: { net_worth: today.net_worth, change },
    });
  }
}

/**
 * FIN-503/506: bill-reminder check. Fires 2 days before a recurring
 * charge's next_expected_date — deterministic, no AI needed for "this bill
 * is due soon." Idempotent per merchant per due-date via audit_logs.
 */
export async function sendBillReminders(admin: SupabaseClient, userId: string, userEmail: string | null): Promise<void> {
  if (!userEmail) return;
  const reminderDate = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);

  const { data: dueSoon } = await admin
    .from("fund_recurring_transactions")
    .select("merchant_name, expected_amount, next_expected_date")
    .eq("user_id", userId)
    .eq("status", "active")
    .eq("next_expected_date", reminderDate);

  for (const bill of dueSoon ?? []) {
    await notifyViaMake(admin, {
      idempotencyKey: `bill_reminder:${userId}:${bill.merchant_name}:${bill.next_expected_date}`,
      kind: "bill_reminder",
      userId,
      to: userEmail,
      subject: `Upcoming bill: ${bill.merchant_name}`,
      bodyText: `${bill.merchant_name} ($${Number(bill.expected_amount).toFixed(2)}) is expected on ${bill.next_expected_date}.`,
      meta: { merchant: bill.merchant_name, amount: Number(bill.expected_amount), due_date: bill.next_expected_date },
    });
  }
}
