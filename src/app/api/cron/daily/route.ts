import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createAdminClient } from "@/lib/supabase/admin";
import { optionalEnv } from "@/lib/env";

// Vercel cron: runs daily at 06:00 UTC (configured in vercel.json)
// GitHub Actions also triggers this at 07:00 UTC via daily-health.yml.
// Requires CRON_SECRET env var — Vercel sets the Authorization header automatically
// when invoking crons; set the same secret in your project env vars.
export async function GET(req: NextRequest) {
  const cronSecret = optionalEnv("CRON_SECRET");
  if (!cronSecret) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 503 });
  }
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Maintenance RPCs run only through the service role. Their EXECUTE grants
  // are revoked from browser-facing roles by migration 202607151310.
  const supabase = createAdminClient();
  if (!supabase) {
    return NextResponse.json({ error: "Maintenance database unavailable" }, { status: 503 });
  }
  const results: Record<string, unknown> = {};
  const maintenanceFailure = (operation: string, error: unknown) => {
    Sentry.captureException(error instanceof Error ? error : new Error("Maintenance operation failed"), {
      tags: { area: "cron", route: "/api/cron/daily", operation },
    });
    return { ok: false, error: "MAINTENANCE_OPERATION_FAILED", operation };
  };

  // 1. Mark overdue tasks via SECURITY DEFINER function
  const { data: overdueCount, error: tasksError } = await supabase.rpc("mark_overdue_tasks");
  results.overdue_tasks = tasksError
    ? maintenanceFailure("mark_overdue_tasks", tasksError)
    : { updated: overdueCount ?? 0 };

  // 2. Delete old routed signals via SECURITY DEFINER function
  const { data: deletedCount, error: signalsError } = await supabase.rpc("cleanup_old_signals");
  results.old_signals_deleted = signalsError
    ? maintenanceFailure("cleanup_old_signals", signalsError)
    : { deleted: deletedCount ?? 0 };

  // 3. Clean up expired WebAuthn challenges
  const { data: challengesDeleted, error: challengesError } = await supabase.rpc("cleanup_expired_challenges");
  results.expired_challenges_deleted = challengesError
    ? maintenanceFailure("cleanup_expired_challenges", challengesError)
    : { deleted: challengesDeleted ?? 0 };

  // 4. Purge old done tasks (> 6 months, per migration 022)
  const { data: purgedCount, error: purgeError } = await supabase.rpc("purge_old_done_tasks");
  results.old_done_tasks_purged = purgeError
    ? maintenanceFailure("purge_old_done_tasks", purgeError)
    : { deleted: purgedCount ?? 0 };

  // 4b. Expire stale pending approvals (hygiene; the execute gate already
  // refuses expired approvals — this just keeps the queue accurate).
  const { data: expiredApprovals, error: approvalsError } = await supabase.rpc("expire_stale_approvals");
  results.stale_approvals_expired = approvalsError
    ? maintenanceFailure("expire_stale_approvals", approvalsError)
    : { updated: expiredApprovals ?? 0 };

  // 5. Dependency freshness check (sample 3 key packages)
  const WATCH_PKGS = ["next", "@supabase/ssr", "anthropic"];
  const depResults: Record<string, { current: string; latest: string; behind: boolean }> = {};
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkgJson = require("../../../../../package.json");
    await Promise.all(
      WATCH_PKGS.map(async (pkg) => {
        try {
          const res = await fetch(
            `https://registry.npmjs.org/${encodeURIComponent(pkg)}/latest`,
            { signal: AbortSignal.timeout(5000) }
          );
          if (res.ok) {
            const data = await res.json() as { version: string };
            const raw: string =
              (pkgJson.dependencies?.[pkg] as string | undefined) ??
              (pkgJson.devDependencies?.[pkg] as string | undefined) ??
              "unknown";
            const current = raw.replace(/[\^~]/, "");
            const latest = data.version;
            depResults[pkg] = { current, latest, behind: current !== "unknown" && latest !== current };
          }
        } catch {
          /* skip individual package errors */
        }
      })
    );
  } catch {
    /* skip if package.json unreadable */
  }
  results.dependency_check = depResults;

  // 6. Supabase health check
  try {
    const { error } = await supabase.from("notes").select("id").limit(1);
    results.supabase_health = error
      ? maintenanceFailure("supabase_health", error)
      : { ok: true };
  } catch (e) {
    results.supabase_health = maintenanceFailure("supabase_health", e);
  }

  const hasFailures = Object.values(results).some(
    (result) => result && typeof result === "object" && "ok" in result && result.ok === false,
  );

  // 7. Store run in health_check_runs (migration 016)
  const runSummary = {
    ran_at: new Date().toISOString(),
    overdue_tasks: results.overdue_tasks,
    old_signals_deleted: results.old_signals_deleted,
    dependency_check: results.dependency_check,
    supabase_health: results.supabase_health,
    all_ok: !hasFailures,
  };
  const { error: healthInsertError } = await supabase.from("health_check_runs").insert(runSummary);
  if (healthInsertError) {
    maintenanceFailure("persist_health_check", healthInsertError);
  }

  return NextResponse.json(
    { ok: !hasFailures && !healthInsertError, message: "Maintenance complete", results },
    { status: hasFailures || healthInsertError ? 502 : 200 },
  );
}
