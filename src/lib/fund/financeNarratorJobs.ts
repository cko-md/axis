import type { SupabaseClient } from "@supabase/supabase-js";
import type Anthropic from "@anthropic-ai/sdk";
import { notifyViaMake } from "@/lib/fund/notifyViaMake";
import type { NotifyResult } from "@/lib/fund/notifyViaMake";
import { cleanFinanceLabel, shapeRecurringForFinancialNarration } from "@/lib/fund/financeNarratorContext";
import { activityAnomalyReason, assessActivityAnomaly } from "@/lib/fund/activityRules";
import { noNotifications, notificationOutcome, type FinanceNotificationOutcome } from "@/lib/fund/notificationOutcome";
import type { FinancialSnapshotOutcome } from "@/lib/fund/financialTruth";
import {
  addMinorUnits,
  minorUnitsToDecimalString,
  normalizeFinancialCurrency,
  strictExactMinorUnits,
  strictMinorUnits,
} from "@/lib/fund/financialTruth";
import {
  detectedRecurringMatchesCoverage,
  readCompleteTransactionCoverage,
  transactionRowsMatchCoverage,
  TRANSACTION_HISTORY_DAYS,
} from "@/lib/fund/transactionCoverage";

const CADENCE_DAYS: Record<string, number> = { weekly: 7, biweekly: 14, monthly: 30, quarterly: 91, annual: 365 };

function ensureJobActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Finance job aborted", "AbortError");
}

function requiredUsdMinor(value: unknown, currency: unknown = "USD"): number {
  if (currency !== "USD") throw new Error("FINANCE_INPUT_CURRENCY_UNAVAILABLE");
  const minor = strictMinorUnits(value, "USD");
  if (minor === null || !Number.isSafeInteger(minor)) throw new Error("FINANCE_INPUT_AMOUNT_INVALID");
  return minor;
}

function addMinor(total: number, next: number): number {
  const result = addMinorUnits(total, next);
  if (result === null) throw new Error("FINANCE_INPUT_OUT_OF_RANGE");
  return result;
}

/**
 * FIN-503: budget-threshold check. Deterministic, no AI — crossing 90% of a
 * category's monthly_limit fires a Make alert directly (no narration step;
 * a threshold crossing doesn't need interpretation). Supplies a stable
 * category/month key for Make-side deduplication.
 */
export async function checkBudgetThresholds(
  admin: SupabaseClient,
  userId: string,
  userEmail: string | null,
  signal?: AbortSignal,
): Promise<FinanceNotificationOutcome> {
  ensureJobActive(signal);
  if (!userEmail) return noNotifications();
  const monthStart = new Date();
  monthStart.setDate(1);
  const since = monthStart.toISOString().slice(0, 10);
  const monthKey = since.slice(0, 7);
  const coverage = await readCompleteTransactionCoverage(
    admin,
    userId,
    since,
    new Date().toISOString().slice(0, 10),
    signal,
  );
  if (!coverage.available) return noNotifications();

  const [{ data: budgets, error: budgetError }, { data: txns, error: transactionError }] = await Promise.all([
    admin.from("fund_category_budgets").select("category, monthly_limit, currency").eq("user_id", userId),
    admin
      .from("fund_bank_transactions")
      .select("custom_category, plaid_category, amount, amount_minor, iso_currency_code, connection_id, retrieved_at, generation_id, authority")
      .eq("user_id", userId)
      .eq("is_transfer", false)
      .eq("excluded_from_budget", false)
      .lt("amount", 0)
      .gte("posted_date", since),
  ]);
  if (budgetError) throw budgetError;
  if (transactionError) throw transactionError;
  if (!transactionRowsMatchCoverage(txns ?? [], coverage)) return noNotifications();

  const spendByCategoryCurrency = new Map<string, number>();
  for (const t of txns ?? []) {
    if (!t.connection_id || !t.retrieved_at) throw new Error("FINANCE_INPUT_PROVENANCE_UNAVAILABLE");
    const currency = normalizeFinancialCurrency(t.iso_currency_code, "");
    const amountMinor = currency ? strictExactMinorUnits(t.amount, currency) : null;
    if (!currency || amountMinor === null) throw new Error("FINANCE_INPUT_AMOUNT_INVALID");
    if (amountMinor >= 0) throw new Error("FINANCE_INPUT_SIGN_INVALID");
    const cat = cleanFinanceLabel(t.custom_category ?? t.plaid_category, "uncategorized");
    const key = `${cat}\u0000${currency}`;
    spendByCategoryCurrency.set(
      key,
      addMinor(spendByCategoryCurrency.get(key) ?? 0, Math.abs(amountMinor)),
    );
  }

  const results: NotifyResult[] = [];
  for (const b of budgets ?? []) {
    const category = cleanFinanceLabel(b.category, "uncategorized");
    const currency = normalizeFinancialCurrency(b.currency, "");
    const limitMinor = currency ? strictExactMinorUnits(b.monthly_limit, currency) : null;
    if (!currency || limitMinor === null) throw new Error("FINANCE_INPUT_AMOUNT_INVALID");
    if (limitMinor <= 0) continue;
    const spentMinor = spendByCategoryCurrency.get(`${category}\u0000${currency}`) ?? 0;
    if (BigInt(spentMinor) * BigInt(10) < BigInt(limitMinor) * BigInt(9)) continue;
    const spent = minorUnitsToDecimalString(spentMinor, currency);
    const limit = minorUnitsToDecimalString(limitMinor, currency);
    if (!spent || !limit) throw new Error("FINANCE_INPUT_OUT_OF_RANGE");
    const percent = ((BigInt(spentMinor) * BigInt(100) + BigInt(limitMinor) / BigInt(2)) / BigInt(limitMinor)).toString();

    results.push(await notifyViaMake(admin, {
      idempotencyKey: `budget_alert:${userId}:${category}:${currency}:${monthKey}`,
      kind: "budget_alert",
      userId,
      to: userEmail,
      subject: `Budget alert: ${category} is at ${percent}%`,
      bodyText: `You've spent ${currency} ${spent} of your ${currency} ${limit} ${category} budget this month.`,
      meta: { category, spent, spent_minor: spentMinor, limit, limit_minor: limitMinor, currency },
    }));
  }
  return notificationOutcome(results);
}

/**
 * FIN-503: anomaly detection. Policy lives in activityRules so the result is
 * deterministic, typed, and minor-unit exact. This job only fetches history
 * and delivers a review signal; it never authorizes a financial action.
 */
export async function detectAndExplainAnomalies(
  admin: SupabaseClient,
  userId: string,
  userEmail: string | null,
  _anthropic: Anthropic | null,
  signal?: AbortSignal,
): Promise<FinanceNotificationOutcome> {
  ensureJobActive(signal);
  void _anthropic;
  const since90 = new Date(Date.now() - TRANSACTION_HISTORY_DAYS * 86400000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const coverage = await readCompleteTransactionCoverage(admin, userId, since90, today, signal);
  if (!coverage.available) return noNotifications();

  const { data: history, error: historyError } = await admin
    .from("fund_bank_transactions")
    .select("id, merchant_name, amount, amount_minor, iso_currency_code, posted_date, is_transfer, pending, connection_id, retrieved_at, generation_id, authority")
    .eq("user_id", userId)
    .eq("is_transfer", false)
    .lt("amount", 0)
    .gte("posted_date", since90);

  const { data: todays, error: todayError } = await admin
    .from("fund_bank_transactions")
    .select("id, merchant_name, amount, amount_minor, iso_currency_code, posted_date, is_transfer, pending, connection_id, retrieved_at, generation_id, authority")
    .eq("user_id", userId)
    .eq("is_transfer", false)
    .lt("amount", 0)
    .eq("posted_date", today);
  if (historyError) throw historyError;
  if (todayError) throw todayError;

  if (!todays || todays.length === 0) return noNotifications();
  if (!transactionRowsMatchCoverage([...(history ?? []), ...todays], coverage)) {
    return noNotifications();
  }
  // Missing lineage in either the current row or its comparison population
  // cannot be interpreted as a new merchant or a trustworthy baseline.
  if ([...(history ?? []), ...todays].some((row) =>
    typeof row.connection_id !== "string"
    || !row.connection_id
    || typeof row.retrieved_at !== "string"
    || !row.retrieved_at
  )) return noNotifications();
  if (
    coverage.synthetic_test_client
    && (history ?? []).filter((entry) => entry.posted_date !== today).length === 0
  ) return noNotifications();

  const results: NotifyResult[] = [];
  for (const t of todays) {
    const assessment = assessActivityAnomaly({
      id: t.id,
      merchantName: t.merchant_name,
      amount: t.amount,
      currency: t.iso_currency_code,
      isTransfer: t.is_transfer,
      pending: t.pending,
    }, (history ?? []).filter((entry) => entry.posted_date !== today));
    const reason = activityAnomalyReason(assessment);
    if (!reason) continue;
    if (!assessment.available || assessment.amountMinor === null) {
      throw new Error("ANOMALY_INPUT_UNAVAILABLE");
    }

    const merchant = cleanFinanceLabel(t.merchant_name, "Unknown merchant");
    const amount = minorUnitsToDecimalString(assessment.amountMinor, assessment.currency);
    const average = assessment.baselineAverageMinor === null
      ? null
      : minorUnitsToDecimalString(assessment.baselineAverageMinor, assessment.currency);
    if (!amount || (assessment.baselineAverageMinor !== null && !average)) {
      throw new Error("ANOMALY_INPUT_UNAVAILABLE");
    }
    const isNewMerchant = assessment.reason === "new_merchant_high_amount";

    if (userEmail) {
      results.push(await notifyViaMake(admin, {
        idempotencyKey: `anomaly_alert:${userId}:${t.id}`,
        kind: "anomaly_alert",
        userId,
        to: userEmail,
        subject: `Unusual transaction: ${merchant}`,
        bodyText: `Flagged ${reason} at ${merchant} on ${t.posted_date}.`,
        meta: { transaction_id: t.id, amount, currency: assessment.currency, reason: assessment.reason },
      }));
    }

    const body = `Flagged a transaction at ${merchant} for ${amount} ${assessment.currency} on ${t.posted_date} — ${reason}.`;

    const { error: insightError } = await admin.from("ai_insights").insert({
      user_id: userId,
      kind: "anomaly",
      title: `Unusual transaction: ${merchant}`,
      body,
      data_used: { transaction_id: t.id, merchant, amount, currency: assessment.currency, is_new_merchant: isNewMerchant, trailing_average: average },
      assumptions: isNewMerchant
        ? "Flagged because no comparable prior transaction exists for this merchant and currency in the last 90 days."
        : "Flagged because the amount exceeds 2x the merchant's same-currency 90-day trailing average.",
      confidence: "low",
      requires_review: true,
    });
    if (insightError) throw insightError;
  }
  return notificationOutcome(results);
}

/**
 * FIN-504: weekly recap — only generates once every ~7 days (checked
 * against the last weekly_recap row). Deltas and narration are deterministic;
 * external labels remain untrusted data and every recap requires review.
 */
export async function writeWeeklyRecap(
  admin: SupabaseClient,
  userId: string,
  userEmail: string | null,
  _anthropic: Anthropic | null,
  snapshot: FinancialSnapshotOutcome,
  signal?: AbortSignal,
): Promise<FinanceNotificationOutcome> {
  ensureJobActive(signal);
  if (snapshot.status !== "fresh" || snapshot.authority !== "provider") return noNotifications();
  const { data: lastRecap, error: lastRecapError } = await admin
    .from("ai_insights")
    .select("created_at")
    .eq("user_id", userId)
    .eq("kind", "weekly_recap")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lastRecapError) throw lastRecapError;
  if (lastRecap && Date.now() - new Date(lastRecap.created_at).getTime() < 7 * 86400000) return noNotifications();

  const { data: snapshots, error: snapshotError } = await admin
    .from("net_worth_snapshots_exact")
    .select("captured_on, net_worth, currency")
    .eq("user_id", userId)
    .eq("authority", "provider")
    .eq("snapshot_status", "fresh")
    .eq("calculation_version", "financial-truth-v2")
    .order("captured_on", { ascending: false })
    .limit(8);
  if (snapshotError) throw snapshotError;
  if (!snapshots || snapshots.length < 2) return noNotifications();

  const today = snapshots[0];
  const weekAgo = snapshots.find((s) => new Date(today.captured_on).getTime() - new Date(s.captured_on).getTime() >= 6 * 86400000) ?? snapshots[snapshots.length - 1];
  const todayMinor = strictMinorUnits(today.net_worth, today.currency ?? "");
  const weekAgoMinor = strictMinorUnits(weekAgo.net_worth, weekAgo.currency ?? "");
  const netWorthChangeMinor = todayMinor === null || weekAgoMinor === null
    ? null
    : addMinorUnits(todayMinor, -weekAgoMinor);
  if (todayMinor === null || weekAgoMinor === null || netWorthChangeMinor === null) {
    throw new Error("NET_WORTH_HISTORY_INVALID");
  }
  const todayExact = minorUnitsToDecimalString(todayMinor, "USD");
  const changeExact = minorUnitsToDecimalString(netWorthChangeMinor, "USD");
  if (!todayExact || !changeExact) throw new Error("NET_WORTH_HISTORY_INVALID");

  const since = weekAgo.captured_on;
  const { data: txns, error: transactionError } = await admin
    .from("fund_bank_transactions")
    .select("custom_category, plaid_category, amount, amount_minor, iso_currency_code, connection_id, retrieved_at, generation_id, authority")
    .eq("user_id", userId)
    .eq("is_transfer", false)
    .lt("amount", 0)
    .gte("posted_date", since);
  if (transactionError) throw transactionError;
  const coverage = await readCompleteTransactionCoverage(
    admin,
    userId,
    since,
    today.captured_on,
    signal,
  );
  if (!coverage.available || !transactionRowsMatchCoverage(txns ?? [], coverage)) {
    return noNotifications();
  }
  const spendByCategory = new Map<string, number>();
  for (const t of txns ?? []) {
    if (!t.connection_id || !t.retrieved_at) throw new Error("FINANCE_INPUT_PROVENANCE_UNAVAILABLE");
    const amountMinor = requiredUsdMinor(t.amount, t.iso_currency_code);
    if (amountMinor >= 0) throw new Error("FINANCE_INPUT_SIGN_INVALID");
    const cat = cleanFinanceLabel(t.custom_category ?? t.plaid_category, "uncategorized");
    spendByCategory.set(cat, addMinor(spendByCategory.get(cat) ?? 0, Math.abs(amountMinor)));
  }
  const topCategories = [...spendByCategory.entries()]
    .sort((a, b) => b[1] === a[1] ? 0 : b[1] > a[1] ? 1 : -1)
    .slice(0, 3)
    .map(([category, totalMinor]) => ({
      category,
      total: minorUnitsToDecimalString(totalMinor, "USD"),
      total_minor: totalMinor,
      currency: "USD",
    }));

  const { data: newRecurring, error: recurringError } = await admin
    .from("fund_recurring_transactions")
    .select("merchant_name, expected_amount, currency, source, source_generation_hash")
    .eq("user_id", userId)
    .gte("created_at", since);
  if (recurringError) throw recurringError;
  const authoritativeRecurring = (newRecurring ?? []).filter((row) =>
    detectedRecurringMatchesCoverage(row, coverage),
  );

  const dataPayload = {
    net_worth_change: changeExact,
    net_worth_today: todayExact,
    currency: "USD",
    period_start: weekAgo.captured_on,
    period_end: today.captured_on,
    top_spend_categories: topCategories,
    new_recurring_charges: shapeRecurringForFinancialNarration(authoritativeRecurring),
  };

  const body = `Net worth ${netWorthChangeMinor >= 0 ? "rose" : "fell"} $${minorUnitsToDecimalString(Math.abs(netWorthChangeMinor), "USD")} this week, now $${todayExact}. Top spend: ${topCategories.map(({ category, total }) => `${category} ($${total})`).join(", ") || "none recorded"}.`;

  const { error: insightError } = await admin.from("ai_insights").insert({
    user_id: userId,
    kind: "weekly_recap",
    title: "Weekly recap",
    body,
    data_used: dataPayload,
    assumptions: "Net worth delta and category spend are computed deterministically from provider-authoritative snapshots and transactions; no AI narration is applied.",
    confidence: "low",
    requires_review: true,
  });
  if (insightError) throw insightError;

  if (userEmail) {
    return notificationOutcome([await notifyViaMake(admin, {
      idempotencyKey: `weekly_recap:${userId}:${today.captured_on}`,
      kind: "weekly_recap",
      userId,
      to: userEmail,
      subject: "Your weekly finance recap",
      bodyText: body,
      meta: dataPayload,
    })]);
  }
  return noNotifications();
}

/**
 * FIN-504: subscription audit — flags recurring charges with no
 * transaction seen in over 2x their expected cadence (might be cancelled
 * and still billing, or the merchant changed its statement name). Runs on
 * the same ~7-day cadence as the weekly recap.
 */
export async function writeSubscriptionAudit(
  admin: SupabaseClient,
  userId: string,
  userEmail: string | null,
  _anthropic: Anthropic | null,
  signal?: AbortSignal,
): Promise<FinanceNotificationOutcome> {
  ensureJobActive(signal);
  void _anthropic;
  const { data: lastAudit, error: lastAuditError } = await admin
    .from("ai_insights")
    .select("created_at")
    .eq("user_id", userId)
    .eq("kind", "subscription_audit")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lastAuditError) throw lastAuditError;
  if (lastAudit && Date.now() - new Date(lastAudit.created_at).getTime() < 7 * 86400000) return noNotifications();

  const { data: recurring, error: recurringError } = await admin
    .from("fund_recurring_transactions")
    .select("merchant_name, expected_amount, currency, cadence, last_seen_date, source, source_generation_hash")
    .eq("user_id", userId)
    .eq("status", "active");
  if (recurringError) throw recurringError;
  if (!recurring || recurring.length === 0) return noNotifications();
  const detectedRows = recurring.filter((row) => row.source === "detected");
  const coverage = detectedRows.length > 0
    ? await readCompleteTransactionCoverage(
        admin,
        userId,
        new Date(Date.now() - TRANSACTION_HISTORY_DAYS * 86_400_000).toISOString().slice(0, 10),
        new Date().toISOString().slice(0, 10),
        signal,
      )
    : null;
  const authoritativeRecurring = recurring.filter((row) =>
    row.source === "manual"
    || (coverage !== null && detectedRecurringMatchesCoverage(row, coverage)),
  );

  const stale = authoritativeRecurring.filter((r) => {
    if (!r.last_seen_date) return false;
    const cadenceDays = CADENCE_DAYS[r.cadence] ?? 30;
    const daysSinceLastSeen = (Date.now() - new Date(r.last_seen_date).getTime()) / 86400000;
    return daysSinceLastSeen > cadenceDays * 2;
  });
  if (stale.length === 0) return noNotifications();

  const shapedStale = shapeRecurringForFinancialNarration(stale);
  const dataPayload = { stale_subscriptions: shapedStale };
  const body = `${shapedStale.length} recurring charge${shapedStale.length > 1 ? "s" : ""} haven't shown up in a while: ${shapedStale.map((s) => s.merchant_name).join(", ")}. They might be cancelled but still billing, or just renamed on your statement — worth a check.`;

  const { error: insightError } = await admin.from("ai_insights").insert({
    user_id: userId,
    kind: "subscription_audit",
    title: "Subscription audit",
    body,
    data_used: dataPayload,
    assumptions: "Flagged when a recurring charge hasn't been seen in over 2x its expected cadence — based on fund_recurring_transactions.last_seen_date.",
    confidence: "low",
    requires_review: true,
  });
  if (insightError) throw insightError;

  if (userEmail) {
    return notificationOutcome([await notifyViaMake(admin, {
      idempotencyKey: `subscription_audit:${userId}:${new Date().toISOString().slice(0, 10)}`,
      kind: "subscription_audit",
      userId,
      to: userEmail,
      subject: "Subscription audit: a few charges look stale",
      bodyText: body,
      meta: dataPayload,
    })]);
  }
  return noNotifications();
}
