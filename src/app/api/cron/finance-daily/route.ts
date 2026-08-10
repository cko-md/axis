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
const MAX_USERS_PER_RUN = 250;
const CRON_WALL_CLOCK_MS = 50_000;
const ABORT_SETTLEMENT_GRACE_MS = 2_000;
const CRON_LEASE_SECONDS = 120;

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
  const operationPromise = operation(controller.signal);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ timedOut: true });
    }, remaining);
  });
  try {
    const outcome = await Promise.race([
      operationPromise.then((value) => ({ timedOut: false as const, value })),
      timeout,
    ]);
    if (outcome.timedOut) {
      // Every job re-checks this signal after awaited reads and before later
      // writes/notifications. Drain normal cancellation, but do not let an
      // unabortable provider/client promise hang the cron indefinitely.
      const settled = await Promise.race([
        operationPromise.then(
          () => true,
          () => true,
        ),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), ABORT_SETTLEMENT_GRACE_MS)),
      ]);
      if (!settled) {
        Sentry.captureException(new Error("Finance daily job did not settle after cancellation"), {
          tags: { area: "fund", stage: "deadline", code: "ABORT_SETTLEMENT_EXCEEDED" },
        });
      }
      throw new FinanceCronDeadlineError();
    }
    return outcome.value;
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
  const runId = crypto.randomUUID();
  const lease = await admin.rpc("acquire_finance_cron_run", {
    p_run_id: runId,
    p_lease_seconds: CRON_LEASE_SECONDS,
  });
  if (lease.error) {
    Sentry.captureException(new Error("Finance daily lease acquisition failed"), {
      tags: { area: "fund", stage: "lease", code: "LEASE_ACQUIRE_FAILED" },
    });
    return NextResponse.json({ ok: false, outcome: "systemic_failure", error: "FINANCE_CRON_LEASE_UNAVAILABLE" }, { status: 503 });
  }
  if (lease.data !== true) {
    return NextResponse.json({ ok: true, outcome: "busy", reason: "FINANCE_CRON_ALREADY_RUNNING" });
  }
  let releaseLease = true;

  try {
    const deadline = Date.now() + CRON_WALL_CLOCK_MS;

    const connectionClaim = await admin.rpc("claim_finance_cron_connections", {
      p_run_id: runId,
      p_limit: MAX_SYNC_CONNECTIONS,
    });
    const connections = connectionClaim.data ?? [];
    const connectionsError = connectionClaim.error;

    let syncedConnections = 0;
    let syncErrors = connectionsError ? 1 : 0;
    let deadlineExceeded = false;
    let connectionClaimIncomplete = Boolean(connectionsError);
    const connectionLimitExceeded = false;
    if (connectionsError) {
      Sentry.captureException(new Error("Finance daily connection discovery failed"), { tags: { area: "fund", stage: "connection_discovery", code: "CONNECTION_QUERY_FAILED" } });
    }
    for (const c of connections) {
    if (Date.now() >= deadline) {
      deadlineExceeded = true;
      syncErrors += 1;
      connectionClaimIncomplete = true;
      break;
    }
    let synchronized = false;
    if (!c.access_token_enc) {
      syncErrors++;
      connectionClaimIncomplete = true;
    }
    else {
      const accessToken = decrypt(c.access_token_enc);
      if (!accessToken) {
        syncErrors++;
        connectionClaimIncomplete = true;
      }
      else {
        let result: Awaited<ReturnType<typeof syncPlaidTransactions>> | null = null;
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
          connectionClaimIncomplete = true;
        }
        if (result && "error" in result) {
          console.error("[cron/finance-daily] sync failed", { code: "SYNC_FAILED" });
          if (result.error !== "PLAID_TXN_DEADLINE_EXCEEDED") {
            Sentry.captureException(new Error("Finance daily Plaid sync failed"), {
              tags: { area: "fund", stage: "sync", code: result.error },
            });
          }
          syncErrors++;
          connectionClaimIncomplete = true;
        } else if (result) {
          syncedConnections++;
          synchronized = true;
        }
      }
    }
    if (!synchronized) break;
    const ack = await admin.rpc("ack_finance_cron_connection", {
      p_run_id: runId,
      p_connection_id: c.id,
    });
    if (ack.error || ack.data !== true) {
      Sentry.captureException(new Error("Finance daily connection acknowledgement failed"), {
        tags: { area: "fund", stage: "connection_ack", code: "CONNECTION_ACK_FAILED" },
      });
      syncErrors += 1;
      connectionClaimIncomplete = true;
      break;
    }
    if (Date.now() >= deadline) {
      deadlineExceeded = true;
      syncErrors += 1;
      connectionClaimIncomplete = true;
      break;
    }
    }

    if (deadlineExceeded || connectionClaimIncomplete) {
      if (deadlineExceeded) releaseLease = false;
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
      deadlineExceeded,
    }, { status: 503 });
    }

    const userClaim = await admin.rpc("claim_finance_cron_users", {
      p_run_id: runId,
      p_limit: MAX_USERS_PER_RUN,
    });
  const discoveryLimitExceeded = false;
  const discoveryErrors = userClaim.error ? 1 : 0;
  if (discoveryErrors > 0) {
    Sentry.captureException(new Error("Finance daily user discovery failed"), { tags: { area: "fund", stage: "user_discovery", code: "USER_DISCOVERY_QUERY_FAILED" } });
  }
  const userIds = (userClaim.data ?? []).map((row: { user_id: string }) => row.user_id);
  const userLimitExceeded = false;

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
      userFailures += userIds.length - index;
      Sentry.captureException(new Error("Finance daily user lookup failed"), { tags: { area: "fund", stage: "user_lookup", code: "AUTH_USER_LOOKUP_FAILED" } });
      break;
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
      const ack = await admin.rpc("ack_finance_cron_user", {
        p_run_id: runId,
        p_user_id: userId,
      });
      if (ack.error || ack.data !== true) {
        throw new Error("FINANCE_CRON_USER_ACK_FAILED");
      }
      usersCompleted += 1;
    } catch (error) {
      if (error instanceof FinanceCronDeadlineError) {
        deadlineExceeded = true;
        userFailures += userIds.length - index;
        break;
      }
      userFailures += 1;
      Sentry.captureException(new Error("Finance daily user job failed"), { tags: { area: "fund", stage: "user_job", code: "USER_JOB_FAILED" } });
      break;
    }
    }

    if (Date.now() >= deadline) deadlineExceeded = true;
    if (deadlineExceeded) releaseLease = false;
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
  } finally {
    if (releaseLease) {
      const release = await admin.rpc("release_finance_cron_run", { p_run_id: runId });
      if (release.error || release.data !== true) {
        Sentry.captureException(new Error("Finance daily lease release failed"), {
          tags: { area: "fund", stage: "lease", code: "LEASE_RELEASE_FAILED" },
        });
      }
    }
  }
}
