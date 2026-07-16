import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import * as Sentry from "@sentry/nextjs";
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";
import { optionalEnv } from "@/lib/env";
import { syncPlaidTransactions } from "@/lib/fund/syncPlaidTransactions";
import { detectRecurring, sendBillReminders, snapshotNetWorth, writeDailyBrief } from "@/lib/fund/financeDailyJobs";
import { checkBudgetThresholds, detectAndExplainAnomalies, writeSubscriptionAudit, writeWeeklyRecap } from "@/lib/fund/financeNarratorJobs";

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

  const { data: connections, error: connectionsError } = await admin
    .from("fund_connections")
    .select("id, user_id, access_token_enc")
    .eq("provider", "plaid")
    .eq("status", "linked");
  if (connectionsError) {
    Sentry.captureException(connectionsError, { tags: { area: "fund", route: "/api/cron/finance-daily", operation: "load_connections" } });
    return NextResponse.json({ error: "Unable to load finance connections" }, { status: 502 });
  }

  let syncedConnections = 0;
  let syncErrors = 0;
  for (const c of connections ?? []) {
    if (!c.access_token_enc) continue;
    const accessToken = decrypt(c.access_token_enc);
    if (!accessToken) continue;
    const result = await syncPlaidTransactions(admin, c.user_id, c.id, accessToken);
    if ("error" in result) {
      console.error("[cron/finance-daily] sync failed for connection", c.id, result.error);
      syncErrors++;
    } else {
      syncedConnections++;
    }
  }

  const { data: users, error: usersError } = await admin
    .from("fund_connections")
    .select("user_id")
    .eq("status", "linked");
  const { data: holdingUsers, error: holdingUsersError } = await admin.from("fund_holdings").select("user_id");
  if (usersError || holdingUsersError) {
    Sentry.captureException(usersError ?? holdingUsersError, { tags: { area: "fund", route: "/api/cron/finance-daily", operation: "load_users" } });
    return NextResponse.json({ error: "Unable to load finance users" }, { status: 502 });
  }
  const userIds = [
    ...new Set([...(users ?? []).map((u) => u.user_id), ...(holdingUsers ?? []).map((u) => u.user_id)]),
  ];

  const anthropicApiKey = optionalEnv("ANTHROPIC_API_KEY");
  const anthropic = anthropicApiKey ? new Anthropic({ apiKey: anthropicApiKey }) : null;
  let userErrors = 0;

  for (const userId of userIds) {
    try {
      const { data: authUser } = await admin.auth.admin.getUserById(userId);
      const userEmail = authUser?.user?.email ?? null;

      await snapshotNetWorth(admin, userId);
      await detectRecurring(admin, userId);
      await writeDailyBrief(admin, userId, userEmail);
      await sendBillReminders(admin, userId, userEmail);
      await checkBudgetThresholds(admin, userId, userEmail);
      await detectAndExplainAnomalies(admin, userId, userEmail, anthropic);
      await writeWeeklyRecap(admin, userId, userEmail, anthropic);
      await writeSubscriptionAudit(admin, userId, userEmail, anthropic);
    } catch (error) {
      userErrors++;
      Sentry.captureException(error instanceof Error ? error : new Error("Finance daily user processing failed"), {
        tags: {
          area: "fund",
          route: "/api/cron/finance-daily",
          operation: "process_user",
        },
      });
    }
  }

  return NextResponse.json({
    ok: true,
    syncedConnections,
    syncErrors,
    usersProcessed: userIds.length,
    userErrors,
  }, { status: syncErrors > 0 || userErrors > 0 ? 502 : 200 });
}
