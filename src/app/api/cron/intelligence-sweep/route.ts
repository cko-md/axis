import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { scanPlatformForUser } from "@/lib/signals/scan";
import { scanForObjectives } from "@/lib/objectives/scan";
import { scanForNewPapers } from "@/lib/literature/watch";
import { optionalEnv } from "@/lib/env";
import * as Sentry from "@sentry/nextjs";

const DEBRIEF_STALE_DAYS = 6;
const OBJECTIVE_DEDUP_WINDOW_DAYS = 30;

type UserSweepResult = {
  platform_scan?: { created: number } | { error: string };
  objectives_scan?: { suggested: number; inserted: number; skipped?: string } | { error: string };
  debrief?: { inserted: boolean; reason?: string } | { error: string };
  literature_watch?: { inserted: boolean; newPapers?: number; reason?: string } | { error: string };
  pipeline_deadlines?: { inserted: number } | { error: string };
};

const ABSTRACT_DUE_WINDOW_DAYS = 7;

// Make-triggered consolidated daily sweep: per-user platform scan, objectives
// scan (with its own signal-insertion + dedup on top of the shared lib
// function), debrief-staleness nudge, and Literature paper-watch. One user's
// failure never aborts the rest — each step is independently wrapped.
//
// Auth: bearer MAKE_SWEEP_SECRET (a dedicated secret for this Make-triggered
// channel — NOT the Vercel-cron CRON_SECRET used by /api/cron/daily).
// Uses the service-role admin client to cross user boundaries directly
// (bypasses RLS) — no SECURITY DEFINER RPCs needed, unlike /api/cron/daily.
export async function POST(req: NextRequest) {
  const sweepSecret = optionalEnv("MAKE_SWEEP_SECRET");
  if (!sweepSecret) {
    return NextResponse.json({ error: "MAKE_SWEEP_SECRET not configured" }, { status: 503 });
  }
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${sweepSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();
  if (!supabase) {
    return NextResponse.json({ error: "SUPABASE_SERVICE_ROLE_KEY not configured" }, { status: 503 });
  }

  // Enumerate all users via the admin auth API (service-role only). Paginate
  // defensively — listUsers defaults to 50/page and this account will likely
  // never have that many, but a personal-OS deployment could grow.
  let failures = 0;
  // Capture the ACTUAL thrown error when we have one, so the Sentry issue
  // carries a stack and message instead of a contentless "operation failed".
  // Callers pass the caught error; a bare call (no cause available) still
  // reports, just without a stack.
  const sweepFailure = (operation: string, cause?: unknown) => {
    failures += 1;
    const context = { level: "error" as const, tags: { area: "cron", route: "/api/cron/intelligence-sweep", operation } };
    if (cause !== undefined) {
      Sentry.captureException(cause, context);
    } else {
      Sentry.captureMessage("Intelligence sweep operation failed", context);
    }
    return { error: "SWEEP_OPERATION_FAILED", operation };
  };

  const userIds: string[] = [];
  let page = 1;
  for (;;) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) {
      sweepFailure("list_users");
      return NextResponse.json({ error: "SWEEP_USER_ENUMERATION_FAILED" }, { status: 502 });
    }
    userIds.push(...data.users.map((u) => u.id));
    if (data.users.length < 200) break;
    page += 1;
  }

  const results: Record<string, UserSweepResult> = {};
  // Circuit breaker: the objectives AI is shared across all users, so once it
  // comes back unavailable it is down for everyone this run. Without this, a
  // provider outage cost one slow-failing AI call PER user, and with enough
  // users that accumulated past the Vercel function timeout — which returned a
  // 502 that Make retried for hours. After the first ai-unavailable we skip the
  // step for the rest of the run instead of paying for it again.
  let objectivesAiUnavailable = false;

  for (const userId of userIds) {
    const userResult: UserSweepResult = {};

    // (a) Platform scan — surfaces new actionable signals from tasks context.
    try {
      userResult.platform_scan = await scanPlatformForUser(userId, supabase);
    } catch (cause) {
      userResult.platform_scan = sweepFailure("platform_scan", cause);
    }

    // (b) Objectives scan — scanForObjectives only returns suggestions (same as
    // the manual /api/objectives/scan button); the sweep additionally wraps
    // each one as a signal so it surfaces in the Dispatch inbox, consistent
    // with how (a) and (c) both produce signals. Dedup against the user's
    // last 30 days of signal titles (case-insensitive substring match) since
    // that extra check isn't needed (and isn't present) on the manual button.
    if (objectivesAiUnavailable) {
      // Provider already down this run (see the circuit-breaker note above) —
      // skip the scan for this user rather than pay for another failing call.
      userResult.objectives_scan = { suggested: 0, inserted: 0, skipped: "ai-unavailable" };
    } else try {
      const { results: suggestions, error: scanError, code: scanCode, cause: scanCause } =
        await scanForObjectives(userId, supabase);
      if (scanError) {
        if (scanCode === "insufficient-activity") {
          // Not a failure. The user simply has no fresh tasks/notes/signals to
          // derive objectives from — the same benign "nothing to do" the manual
          // button shows. Reporting it as an error is what produced a Sentry
          // issue with 0 user impact firing every run. Record a skip instead.
          userResult.objectives_scan = { suggested: 0, inserted: 0, skipped: "insufficient-activity" };
        } else if (scanCode === "ai-unavailable") {
          // Transient provider failure on a background job nobody is watching.
          // Trip the circuit breaker so the remaining users skip the call, and
          // capture the REAL error (stack + message) once, at WARNING level so a
          // repeating outage does not escalate/page. The manual button path is
          // unchanged.
          objectivesAiUnavailable = true;
          Sentry.captureException(scanCause ?? new Error("Objectives scan AI unavailable"), {
            level: "warning",
            tags: { area: "cron", route: "/api/cron/intelligence-sweep", operation: "objectives_scan" },
          });
          userResult.objectives_scan = { suggested: 0, inserted: 0, skipped: "ai-unavailable" };
        } else {
          // Genuine operational failure (e.g. platform data could not be read).
          userResult.objectives_scan = sweepFailure("objectives_scan");
        }
      } else {
        const windowStart = new Date(Date.now() - OBJECTIVE_DEDUP_WINDOW_DAYS * 86_400_000).toISOString();
        const { data: recentSignals, error: recentSignalsError } = await supabase
          .from("signals")
          .select("title")
          .eq("user_id", userId)
          .gte("created_at", windowStart);
        if (recentSignalsError) {
          userResult.objectives_scan = sweepFailure("load_objective_signal_history");
          results[userId] = userResult;
          continue;
        }
        const recentLower = (recentSignals ?? []).map((s) => (s.title as string).toLowerCase());

        let inserted = 0;
        for (const sug of suggestions) {
          const targetLower = sug.target.toLowerCase();
          const isDuplicate = targetLower.length > 0 && recentLower.some((t) => t.length > 0 && (t.includes(targetLower) || targetLower.includes(t)));
          if (isDuplicate) continue;
          const { error } = await supabase.from("signals").insert({
            user_id: userId,
            title: sug.target,
            body: `Surfaced from ${sug.module} · confidence: ${sug.confidence}`,
            source: "Objectives",
            signal_type: "fyi",
          });
          if (error) {
            sweepFailure("insert_objective_signal");
          } else {
            inserted += 1;
            recentLower.push(targetLower);
          }
        }
        userResult.objectives_scan = { suggested: suggestions.length, inserted };
      }
    } catch (cause) {
      userResult.objectives_scan = sweepFailure("objectives_scan", cause);
    }

    // (c) Debrief staleness — only nudge users who have used the feature before.
    try {
      const { data: lastDebrief, error: debriefReadError } = await supabase
        .from("notes")
        .select("created_at")
        .eq("user_id", userId)
        .eq("folder", "Debrief")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (debriefReadError) {
        userResult.debrief = sweepFailure("load_debrief");
        results[userId] = userResult;
        continue;
      }

      if (!lastDebrief) {
        userResult.debrief = { inserted: false, reason: "no debrief notes yet — skipped" };
      } else {
        const ageMs = Date.now() - new Date(lastDebrief.created_at as string).getTime();
        const ageDays = ageMs / 86_400_000;
        if (ageDays > DEBRIEF_STALE_DAYS) {
          const { error } = await supabase.from("signals").insert({
            user_id: userId,
            title: "Weekly debrief is overdue",
            source: "Debrief",
            signal_type: "action",
          });
          userResult.debrief = error ? sweepFailure("insert_debrief_signal") : { inserted: true };
        } else {
          userResult.debrief = { inserted: false, reason: `last debrief ${Math.floor(ageDays)}d ago — not stale yet` };
        }
      }
    } catch (cause) {
      userResult.debrief = sweepFailure("debrief_scan", cause);
    }

    // (d) Literature paper-watch — surfaces new papers matching the user's
    // saved topics. scanForNewPapers itself dedupes against literature_saved
    // and its own last_seen_ids tracking column; returns [] for users who've
    // never set Literature topics, so this never nags an unused feature.
    try {
      const newPapers = await scanForNewPapers(userId, supabase);
      if (newPapers.length === 0) {
        userResult.literature_watch = { inserted: false, reason: "no new papers" };
      } else {
        const body = newPapers.map((a) => `• ${a.title} (${a.source})`).join("\n");
        const title = newPapers.length === 1 ? `New paper: ${newPapers[0].title}` : `${newPapers.length} new papers match your topics`;
        const { error } = await supabase.from("signals").insert({
          user_id: userId,
          title,
          body,
          source: "Literature",
          signal_type: "fyi",
        });
        userResult.literature_watch = error ? sweepFailure("insert_literature_signal") : { inserted: true, newPapers: newPapers.length };
      }
    } catch (cause) {
      userResult.literature_watch = sweepFailure("literature_scan", cause);
    }

    // (e) Pipeline deadline watch — nudges when a conference's abstract is due
    // within the next 7 days. No upper-bound-only check on the past side: a
    // conference that's already overdue (e.g. the cron missed a day, or the
    // date was set with under a week's notice) still gets flagged, since the
    // per-conference dedup below means this can only ever fire once — better
    // a one-time late nudge than silently never notifying about a missed date.
    try {
      const { data: conferences, error: conferenceError } = await supabase
        .from("conferences")
        .select("id, name, abstract_due_date")
        .eq("user_id", userId)
        .not("abstract_due_date", "is", null);
      if (conferenceError) {
        userResult.pipeline_deadlines = sweepFailure("load_pipeline_deadlines");
        results[userId] = userResult;
        continue;
      }

      const upcoming = (conferences ?? []).filter((c) => {
        const due = new Date(c.abstract_due_date as string).getTime();
        const daysOut = (due - Date.now()) / 86_400_000;
        return daysOut <= ABSTRACT_DUE_WINDOW_DAYS;
      });

      let inserted = 0;
      for (const c of upcoming) {
        const { data: existing, error: existingError } = await supabase
          .from("signals")
          .select("id")
          .eq("user_id", userId)
          .eq("source", "Pipeline")
          .contains("metadata", { conference_id: c.id })
          .limit(1)
          .maybeSingle();
        if (existingError) {
          sweepFailure("check_pipeline_signal");
          continue;
        }
        if (existing) continue;

        const isOverdue = new Date(c.abstract_due_date as string).getTime() < Date.now();
        const { error } = await supabase.from("signals").insert({
          user_id: userId,
          title: isOverdue ? `Abstract overdue — ${c.name}` : `Abstract due soon — ${c.name}`,
          body: `Abstract for "${c.name}" ${isOverdue ? "was due" : "is due"} ${new Date(c.abstract_due_date as string).toLocaleDateString()}.`,
          source: "Pipeline",
          signal_type: "action",
          metadata: { conference_id: c.id },
        });
        if (error) sweepFailure("insert_pipeline_signal");
        else inserted += 1;
      }
      userResult.pipeline_deadlines = { inserted };
    } catch (cause) {
      userResult.pipeline_deadlines = sweepFailure("pipeline_scan", cause);
    }

    results[userId] = userResult;
  }

  // Same reasoning as /api/cron/feed-digest: a partial failure is not a gateway
  // error. The sweep runs per user and per section, so one user's pipeline scan
  // failing must not present as "the whole sweep was unreachable" — that made
  // Make retry the entire sweep on a backoff forever, re-doing every successful
  // user's work each time.
  //
  // Failures remain fully visible: each one is reported through sweepFailure()
  // and enumerated in `results`, and `ok` is false. Only the transport-level
  // claim changes. User enumeration failing is still 5xx (above) because the
  // sweep then genuinely could not run.
  return NextResponse.json({
    ok: failures === 0,
    ran: true,
    partial: failures > 0,
    failures,
    results,
  });
}
