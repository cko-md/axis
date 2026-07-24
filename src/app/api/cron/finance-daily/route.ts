import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";
import { optionalEnv } from "@/lib/env";
import { isMakeOutboxEncryptionReady } from "@/lib/integrations/makeOutbox";
import { syncPlaidTransactions } from "@/lib/fund/syncPlaidTransactions";
import { detectRecurring, sendBillReminders, snapshotNetWorth, writeDailyBrief } from "@/lib/fund/financeDailyJobs";
import { checkBudgetThresholds, detectAndExplainAnomalies, writeSubscriptionAudit, writeWeeklyRecap } from "@/lib/fund/financeNarratorJobs";

const MAX_SYNC_CONNECTIONS = 100;
const MAX_DISCOVERY_ROWS_PER_TABLE = 500;
const MAX_USERS_PER_RUN = 250;
const CRON_WALL_CLOCK_MS = 50_000;

class FinanceCronDeadlineError extends Error {
  constructor() {
    super("FINANCE_CRON_DEADLINE_EXCEEDED");
    this.name = "FinanceCronDeadlineError";
  }
}

async function runWithinDeadline<T>(
  deadline: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new FinanceCronDeadlineError();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new FinanceCronDeadlineError());
    }, remaining);
  });
  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
}

/**
 * Vercel cron: nightly safety net for everything the Plaid webhook
 * (/api/plaid/webhook) should have already caught, plus the work that has
 * no event trigger — EOD price/net-worth snapshot and recurring-charge
 * detection. CRON_SECRET-gated, mirrors /api/cron/daily.
 *
 * Schedule this in vercel.json once Plaid/Polygon keys are live in
 * production (see verification steps in the implementation plan).
 */
export async function GET(req: NextRequest) {
  const cronSecret = optionalEnv("CRON_SECRET");
  if (!cronSecret) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 503 });
  }
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  if (!admin) {
    return NextResponse.json({ error: "SUPABASE_SERVICE_ROLE_KEY not configured" }, { status: 503 });
  }
  // Notification payloads may contain private financial data. Do not perform
  // work that would create an unauditable/unencrypted delivery path.
  if (!isMakeOutboxEncryptionReady()) {
    return NextResponse.json({ ok: false, outcome: "systemic_failure", error: "OUTBOX_ENCRYPTION_UNAVAILABLE" }, { status: 503 });
  }
  const deadline = Date.now() + CRON_WALL_CLOCK_MS;

  const { data: connections, error: connectionsError } = await admin
    .from("fund_connections")
    .select("id, user_id, access_token_enc")
    .eq("provider", "plaid")
    .eq("status", "linked")
    .eq("authority", "provider_verified")
    .limit(MAX_SYNC_CONNECTIONS + 1);

  let syncedConnections = 0;
  let syncErrors = connectionsError ? 1 : 0;
  let deadlineExceeded = false;
  const connectionLimitExceeded = (connections ?? []).length > MAX_SYNC_CONNECTIONS;
  if (connectionLimitExceeded) syncErrors += 1;
  if (connectionsError) {
    Sentry.captureException(new Error("Finance daily connection discovery failed"), { tags: { area: "fund", stage: "connection_discovery", code: "CONNECTION_QUERY_FAILED" } });
  }
  for (const c of (connections ?? []).slice(0, MAX_SYNC_CONNECTIONS)) {
    if (Date.now() >= deadline) {
      deadlineExceeded = true;
      syncErrors += 1;
      break;
    }
    if (!c.access_token_enc) {
      syncErrors++;
      continue;
    }
    const accessToken = decrypt(c.access_token_enc);
    if (!accessToken) {
      syncErrors++;
      continue;
    }
    let result: Awaited<ReturnType<typeof syncPlaidTransactions>>;
    try {
      result = await syncPlaidTransactions(
        admin,
        c.user_id,
        c.id,
        accessToken,
        AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      );
    } catch {
      Sentry.captureException(new Error("Finance daily Plaid sync failed"), { tags: { area: "fund", stage: "sync", code: "SYNC_UNEXPECTED_FAILURE" } });
      syncErrors++;
      continue;
    }
    if ("error" in result) {
      // Safe code only: provider/db errors can contain private request context.
      console.error("[cron/finance-daily] sync failed", { code: "SYNC_FAILED" });
      syncErrors++;
    } else {
      syncedConnections++;
    }
    if (Date.now() >= deadline) {
      deadlineExceeded = true;
      syncErrors += 1;
      break;
    }
  }

  if (deadlineExceeded) {
    return NextResponse.json({
      ok: false,
      outcome: "partial",
      syncedConnections,
      syncErrors,
      discoveryErrors: 0,
      usersProcessed: 0,
      usersCompleted: 0,
      userFailures: 0,
      authLookupFailures: 0,
      snapshotDeclined: 0,
      notificationFailures: 0,
      connectionLimitExceeded,
      discoveryLimitExceeded: false,
      userLimitExceeded: false,
      deadlineExceeded: true,
    }, { status: 503 });
  }

  const discovery = await Promise.all([
    admin.from("fund_connections").select("user_id").eq("status", "linked").eq("authority", "provider_verified").limit(MAX_DISCOVERY_ROWS_PER_TABLE + 1),
    admin.from("fund_holdings").select("user_id").limit(MAX_DISCOVERY_ROWS_PER_TABLE + 1),
    admin.from("fund_liabilities").select("user_id").limit(MAX_DISCOVERY_ROWS_PER_TABLE + 1),
    admin.from("fund_bank_transactions").select("user_id").limit(MAX_DISCOVERY_ROWS_PER_TABLE + 1),
    admin.from("fund_category_budgets").select("user_id").limit(MAX_DISCOVERY_ROWS_PER_TABLE + 1),
    admin.from("fund_recurring_transactions").select("user_id").limit(MAX_DISCOVERY_ROWS_PER_TABLE + 1),
  ]);
  const discoveryLimitExceeded = discovery.some((result) => (result.data ?? []).length > MAX_DISCOVERY_ROWS_PER_TABLE);
  const discoveryErrors = discovery.filter((result) => result.error).length + (discoveryLimitExceeded ? 1 : 0);
  if (discoveryErrors > 0) {
    Sentry.captureException(new Error("Finance daily user discovery failed"), { tags: { area: "fund", stage: "user_discovery", code: "USER_DISCOVERY_QUERY_FAILED" } });
  }
  const discoveredUserIds = [...new Set(discovery.flatMap((result) => (result.data ?? []).map((row) => row.user_id)))];
  const userLimitExceeded = discoveredUserIds.length > MAX_USERS_PER_RUN;
  const userIds = discoveredUserIds.slice(0, MAX_USERS_PER_RUN);

  let usersCompleted = 0;
  let userFailures = 0;
  let snapshotDeclined = 0;
  let notificationFailures = 0;
  let authLookupFailures = 0;
  for (let index = 0; index < userIds.length; index++) {
    if (Date.now() >= deadline) {
      deadlineExceeded = true;
      userFailures += userIds.length - index;
      break;
    }
    const userId = userIds[index];
    const { data: authUser, error: authUserError } = await admin.auth.admin.getUserById(userId);
    if (authUserError) {
      authLookupFailures++;
      Sentry.captureException(new Error("Finance daily user lookup failed"), { tags: { area: "fund", stage: "user_lookup", code: "AUTH_USER_LOOKUP_FAILED" } });
      continue;
    }
    if (Date.now() >= deadline) {
      deadlineExceeded = true;
      userFailures += userIds.length - index;
      break;
    }
    const userEmail = authUser?.user?.email ?? null;

    try {
      const ensureWithinDeadline = () => {
        if (Date.now() >= deadline) throw new FinanceCronDeadlineError();
      };
      const snapshot = await runWithinDeadline(
        deadline,
        (signal) => snapshotNetWorth(admin, userId, signal),
      );
      ensureWithinDeadline();
      if (snapshot.status !== "fresh" || snapshot.authority !== "provider") snapshotDeclined += 1;
      await runWithinDeadline(deadline, (signal) => detectRecurring(admin, userId, signal));
      ensureWithinDeadline();
      const brief = await runWithinDeadline(
        deadline,
        (signal) => writeDailyBrief(admin, userId, userEmail, snapshot, signal),
      );
      ensureWithinDeadline();
      const reminders = await runWithinDeadline(
        deadline,
        (signal) => sendBillReminders(admin, userId, userEmail, signal),
      );
      ensureWithinDeadline();
      notificationFailures += brief.failed + reminders.failed;
      const budgetAlerts = await runWithinDeadline(
        deadline,
        (signal) => checkBudgetThresholds(admin, userId, userEmail, signal),
      );
      ensureWithinDeadline();
      const anomalies = await runWithinDeadline(
        deadline,
        (signal) => detectAndExplainAnomalies(admin, userId, userEmail, null, signal),
      );
      ensureWithinDeadline();
      const weeklyRecap = await runWithinDeadline(
        deadline,
        (signal) => writeWeeklyRecap(admin, userId, userEmail, null, snapshot, signal),
      );
      ensureWithinDeadline();
      const subscriptionAudit = await runWithinDeadline(
        deadline,
        (signal) => writeSubscriptionAudit(admin, userId, userEmail, null, signal),
      );
      ensureWithinDeadline();
      notificationFailures += budgetAlerts.failed + anomalies.failed + weeklyRecap.failed + subscriptionAudit.failed;
      usersCompleted += 1;
    } catch (error) {
      if (error instanceof FinanceCronDeadlineError) {
        deadlineExceeded = true;
        userFailures += userIds.length - index;
        break;
      }
      userFailures += 1;
      Sentry.captureException(new Error("Finance daily user job failed"), { tags: { area: "fund", stage: "user_job", code: "USER_JOB_FAILED" } });
    }
  }

  if (Date.now() >= deadline) deadlineExceeded = true;
  const partial = syncErrors > 0 || discoveryErrors > 0 || authLookupFailures > 0 || userFailures > 0 || snapshotDeclined > 0 || notificationFailures > 0 || userLimitExceeded || deadlineExceeded;
  return NextResponse.json({
    ok: !partial,
    outcome: partial ? "partial" : "complete",
    syncedConnections,
    syncErrors,
    discoveryErrors,
    usersProcessed: userIds.length,
    usersCompleted,
    userFailures,
    authLookupFailures,
    snapshotDeclined,
    notificationFailures,
    connectionLimitExceeded,
    discoveryLimitExceeded,
    userLimitExceeded,
    deadlineExceeded,
  }, { status: partial ? 503 : 200 });
}
