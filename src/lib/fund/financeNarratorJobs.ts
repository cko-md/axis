import type { SupabaseClient } from "@supabase/supabase-js";
import type Anthropic from "@anthropic-ai/sdk";
import { aiGenerate } from "@/lib/ai/router";
import { notifyViaMake } from "@/lib/fund/notifyViaMake";
import { cleanFinanceLabel, safeMoney, shapeRecurringForNarration } from "@/lib/fund/financeNarratorContext";
import { activityAnomalyReason, assessActivityAnomaly } from "@/lib/fund/activityRules";
import { toMajorUnits } from "@/lib/fund/money";

const CADENCE_DAYS: Record<string, number> = { weekly: 7, biweekly: 14, monthly: 30, quarterly: 91, annual: 365 };

const NARRATOR_GUARDRAIL =
  "You are narrating, not computing. Use ONLY the numbers given in the data below — never estimate, round differently, or introduce a figure that isn't present. Keep it to 2-3 sentences, plain language, no markdown.";

/**
 * FIN-503: budget-threshold check. Deterministic, no AI — crossing 90% of a
 * category's monthly_limit fires a Make alert directly (no narration step;
 * a threshold crossing doesn't need interpretation). Supplies a stable
 * category/month key for Make-side deduplication.
 */
export async function checkBudgetThresholds(admin: SupabaseClient, userId: string, userEmail: string | null): Promise<void> {
  if (!userEmail) return;
  const monthStart = new Date();
  monthStart.setDate(1);
  const since = monthStart.toISOString().slice(0, 10);
  const monthKey = since.slice(0, 7);

  const [{ data: budgets, error: budgetError }, { data: txns, error: transactionError }] = await Promise.all([
    admin.from("fund_category_budgets").select("category, monthly_limit").eq("user_id", userId),
    admin
      .from("fund_bank_transactions")
      .select("custom_category, plaid_category, amount")
      .eq("user_id", userId)
      .eq("is_transfer", false)
      .eq("excluded_from_budget", false)
      .lt("amount", 0)
      .gte("posted_date", since),
  ]);
  if (budgetError) throw budgetError;
  if (transactionError) throw transactionError;

  const spendByCategory = new Map<string, number>();
  for (const t of txns ?? []) {
    const cat = cleanFinanceLabel(t.custom_category ?? t.plaid_category, "uncategorized");
    spendByCategory.set(cat, (spendByCategory.get(cat) ?? 0) + Math.abs(safeMoney(t.amount)));
  }

  for (const b of budgets ?? []) {
    const category = cleanFinanceLabel(b.category, "uncategorized");
    const limit = safeMoney(b.monthly_limit);
    if (limit <= 0) continue;
    const spent = spendByCategory.get(category) ?? 0;
    if (spent / limit < 0.9) continue;

    await notifyViaMake(admin, {
      idempotencyKey: `budget_alert:${userId}:${category}:${monthKey}`,
      kind: "budget_alert",
      userId,
      to: userEmail,
      subject: `Budget alert: ${category} is at ${Math.round((spent / limit) * 100)}%`,
      bodyText: `You've spent $${spent.toFixed(2)} of your $${limit.toFixed(2)} ${category} budget this month.`,
      meta: { category, spent, limit },
    });
  }
}

/**
 * FIN-503: anomaly detection. Policy lives in activityRules so the result is
 * deterministic, typed, and minor-unit exact. This job only fetches history
 * and delivers a review signal; it never authorizes a financial action.
 */
export async function detectAndExplainAnomalies(admin: SupabaseClient, userId: string, userEmail: string | null, anthropic: Anthropic | null): Promise<void> {
  const since90 = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);

  const { data: history, error: historyError } = await admin
    .from("fund_bank_transactions")
    .select("id, merchant_name, amount, iso_currency_code, posted_date, is_transfer, pending")
    .eq("user_id", userId)
    .eq("is_transfer", false)
    .lt("amount", 0)
    .gte("posted_date", since90);

  const { data: todays, error: todayError } = await admin
    .from("fund_bank_transactions")
    .select("id, merchant_name, amount, iso_currency_code, posted_date, is_transfer, pending")
    .eq("user_id", userId)
    .eq("is_transfer", false)
    .lt("amount", 0)
    .eq("posted_date", today);
  if (historyError) throw historyError;
  if (todayError) throw todayError;

  if (!todays || todays.length === 0) return;

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

    const merchant = cleanFinanceLabel(t.merchant_name, "Unknown merchant");
    const amount = toMajorUnits(assessment.amountMinor);
    const avg = assessment.baselineAverageMinor === null ? 0 : toMajorUnits(assessment.baselineAverageMinor);
    const isNewMerchant = assessment.reason === "new_merchant_high_amount";

    if (userEmail) {
      await notifyViaMake(admin, {
        idempotencyKey: `anomaly_alert:${userId}:${t.id}`,
        kind: "anomaly_alert",
        userId,
        to: userEmail,
        subject: `Unusual transaction: ${merchant}`,
        bodyText: `Flagged ${reason} at ${merchant} on ${t.posted_date}.`,
        meta: { transaction_id: t.id, amount, reason: assessment.reason },
      });
    }

    let body = `Flagged a transaction at ${merchant} for ${amount.toFixed(2)} ${assessment.currency} on ${t.posted_date} — ${reason}.`;
    if (anthropic) {
      try {
        const { text } = await aiGenerate({
          mode: "anomaly-explain",
          anthropic,
          system: NARRATOR_GUARDRAIL,
          userMessage: `Data: merchant=${merchant}, amount=${amount.toFixed(2)} ${assessment.currency}, date=${t.posted_date}, is_new_merchant=${isNewMerchant}, trailing_average=${avg.toFixed(2)} ${assessment.currency}. Briefly explain why this transaction was flagged and suggest the user check it's legitimate.`,
          maxTokens: 200,
        });
        if (text.trim()) body = text.trim();
      } catch {
        // narration is best-effort; the deterministic body above already covers the facts
      }
    }

    const { error: insightError } = await admin.from("ai_insights").insert({
      user_id: userId,
      kind: "anomaly",
      title: `Unusual transaction: ${merchant}`,
      body,
      data_used: { transaction_id: t.id, merchant, amount, currency: assessment.currency, is_new_merchant: isNewMerchant, trailing_average: avg },
      assumptions: isNewMerchant
        ? "Flagged because no comparable prior transaction exists for this merchant and currency in the last 90 days."
        : "Flagged because the amount exceeds 2x the merchant's same-currency 90-day trailing average.",
      confidence: "medium",
      requires_review: true,
    });
    if (insightError) throw insightError;
  }
}

/**
 * FIN-504: weekly recap — only generates once every ~7 days (checked
 * against the last weekly_recap row), deterministic deltas computed first,
 * AI narrates strictly from those numbers.
 */
export async function writeWeeklyRecap(admin: SupabaseClient, userId: string, userEmail: string | null, anthropic: Anthropic | null): Promise<void> {
  const { data: lastRecap, error: lastRecapError } = await admin
    .from("ai_insights")
    .select("created_at")
    .eq("user_id", userId)
    .eq("kind", "weekly_recap")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lastRecapError) throw lastRecapError;
  if (lastRecap && Date.now() - new Date(lastRecap.created_at).getTime() < 7 * 86400000) return;

  const { data: snapshots, error: snapshotError } = await admin
    .from("net_worth_snapshots")
    .select("captured_on, net_worth")
    .eq("user_id", userId)
    .order("captured_on", { ascending: false })
    .limit(8);
  if (snapshotError) throw snapshotError;
  if (!snapshots || snapshots.length < 2) return;

  const today = snapshots[0];
  const weekAgo = snapshots.find((s) => new Date(today.captured_on).getTime() - new Date(s.captured_on).getTime() >= 6 * 86400000) ?? snapshots[snapshots.length - 1];
  const netWorthChange = today.net_worth - weekAgo.net_worth;

  const since = weekAgo.captured_on;
  const { data: txns, error: transactionError } = await admin
    .from("fund_bank_transactions")
    .select("custom_category, plaid_category, amount")
    .eq("user_id", userId)
    .eq("is_transfer", false)
    .lt("amount", 0)
    .gte("posted_date", since);
  if (transactionError) throw transactionError;
  const spendByCategory = new Map<string, number>();
  for (const t of txns ?? []) {
    const cat = cleanFinanceLabel(t.custom_category ?? t.plaid_category, "uncategorized");
    spendByCategory.set(cat, (spendByCategory.get(cat) ?? 0) + Math.abs(safeMoney(t.amount)));
  }
  const topCategories = [...spendByCategory.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);

  const { data: newRecurring, error: recurringError } = await admin
    .from("fund_recurring_transactions")
    .select("merchant_name, expected_amount")
    .eq("user_id", userId)
    .gte("created_at", since);
  if (recurringError) throw recurringError;

  const dataPayload = {
    net_worth_change: netWorthChange,
    net_worth_today: today.net_worth,
    period_start: weekAgo.captured_on,
    period_end: today.captured_on,
    top_spend_categories: topCategories.map(([category, total]) => ({ category, total })),
    new_recurring_charges: shapeRecurringForNarration(newRecurring),
  };

  let body = `Net worth ${netWorthChange >= 0 ? "rose" : "fell"} $${Math.abs(netWorthChange).toFixed(0)} this week, now $${today.net_worth.toFixed(0)}. Top spend: ${topCategories.map(([c, t]) => `${c} ($${t.toFixed(0)})`).join(", ") || "none recorded"}.`;
  if (anthropic) {
    try {
      const { text } = await aiGenerate({
        mode: "weekly-recap",
        anthropic,
        system: NARRATOR_GUARDRAIL,
        userMessage: `Data: ${JSON.stringify(dataPayload)}. Write a short weekly recap using only these numbers.`,
        maxTokens: 250,
      });
      if (text.trim()) body = text.trim();
    } catch {
      // deterministic body above already covers the facts
    }
  }

  const { error: insightError } = await admin.from("ai_insights").insert({
    user_id: userId,
    kind: "weekly_recap",
    title: "Weekly recap",
    body,
    data_used: dataPayload,
    assumptions: "Net worth delta and category spend are computed directly from net_worth_snapshots and fund_bank_transactions; the AI only narrates these figures.",
    confidence: "high",
    requires_review: false,
  });
  if (insightError) throw insightError;

  if (userEmail) {
    await notifyViaMake(admin, {
      idempotencyKey: `weekly_recap:${userId}:${today.captured_on}`,
      kind: "weekly_recap",
      userId,
      to: userEmail,
      subject: "Your weekly finance recap",
      bodyText: body,
      meta: dataPayload,
    });
  }
}

/**
 * FIN-504: subscription audit — flags recurring charges with no
 * transaction seen in over 2x their expected cadence (might be cancelled
 * and still billing, or the merchant changed its statement name). Runs on
 * the same ~7-day cadence as the weekly recap.
 */
export async function writeSubscriptionAudit(admin: SupabaseClient, userId: string, userEmail: string | null, anthropic: Anthropic | null): Promise<void> {
  const { data: lastAudit, error: lastAuditError } = await admin
    .from("ai_insights")
    .select("created_at")
    .eq("user_id", userId)
    .eq("kind", "subscription_audit")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lastAuditError) throw lastAuditError;
  if (lastAudit && Date.now() - new Date(lastAudit.created_at).getTime() < 7 * 86400000) return;

  const { data: recurring, error: recurringError } = await admin
    .from("fund_recurring_transactions")
    .select("merchant_name, expected_amount, cadence, last_seen_date")
    .eq("user_id", userId)
    .eq("status", "active");
  if (recurringError) throw recurringError;
  if (!recurring || recurring.length === 0) return;

  const stale = recurring.filter((r) => {
    if (!r.last_seen_date) return false;
    const cadenceDays = CADENCE_DAYS[r.cadence] ?? 30;
    const daysSinceLastSeen = (Date.now() - new Date(r.last_seen_date).getTime()) / 86400000;
    return daysSinceLastSeen > cadenceDays * 2;
  });
  if (stale.length === 0) return;

  const shapedStale = shapeRecurringForNarration(stale);
  const dataPayload = { stale_subscriptions: shapedStale };
  let body = `${shapedStale.length} recurring charge${shapedStale.length > 1 ? "s" : ""} haven't shown up in a while: ${shapedStale.map((s) => s.merchant_name).join(", ")}. They might be cancelled but still billing, or just renamed on your statement — worth a check.`;
  if (anthropic) {
    try {
      const { text } = await aiGenerate({
        mode: "subscription-audit",
        anthropic,
        system: NARRATOR_GUARDRAIL,
        userMessage: `Data: ${JSON.stringify(dataPayload)}. These recurring charges haven't appeared in over 2x their expected cadence. Briefly flag them and suggest checking if still needed.`,
        maxTokens: 250,
      });
      if (text.trim()) body = text.trim();
    } catch {
      // deterministic body above already covers the facts
    }
  }

  const { error: insightError } = await admin.from("ai_insights").insert({
    user_id: userId,
    kind: "subscription_audit",
    title: "Subscription audit",
    body,
    data_used: dataPayload,
    assumptions: "Flagged when a recurring charge hasn't been seen in over 2x its expected cadence — based on fund_recurring_transactions.last_seen_date.",
    confidence: "medium",
    requires_review: true,
  });
  if (insightError) throw insightError;

  if (userEmail) {
    await notifyViaMake(admin, {
      idempotencyKey: `subscription_audit:${userId}:${new Date().toISOString().slice(0, 10)}`,
      kind: "subscription_audit",
      userId,
      to: userEmail,
      subject: "Subscription audit: a few charges look stale",
      bodyText: body,
      meta: dataPayload,
    });
  }
}
