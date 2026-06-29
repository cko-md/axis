import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { scanPlatformForUser } from "@/lib/signals/scan";
import { scanForObjectives } from "@/lib/objectives/scan";
import { scanForNewPapers } from "@/lib/literature/watch";
import { optionalEnv } from "@/lib/env";

const DEBRIEF_STALE_DAYS = 6;
const OBJECTIVE_DEDUP_WINDOW_DAYS = 30;

type UserSweepResult = {
  platform_scan?: { created: number } | { error: string };
  objectives_scan?: { suggested: number; inserted: number } | { error: string };
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
  const userIds: string[] = [];
  let page = 1;
  for (;;) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) {
      return NextResponse.json({ error: `listUsers failed: ${error.message}` }, { status: 500 });
    }
    userIds.push(...data.users.map((u) => u.id));
    if (data.users.length < 200) break;
    page += 1;
  }

  const results: Record<string, UserSweepResult> = {};

  for (const userId of userIds) {
    const userResult: UserSweepResult = {};

    // (a) Platform scan — surfaces new actionable signals from tasks context.
    try {
      userResult.platform_scan = await scanPlatformForUser(userId, supabase);
    } catch (e) {
      userResult.platform_scan = { error: String(e) };
    }

    // (b) Objectives scan — scanForObjectives only returns suggestions (same as
    // the manual /api/objectives/scan button); the sweep additionally wraps
    // each one as a signal so it surfaces in the Dispatch inbox, consistent
    // with how (a) and (c) both produce signals. Dedup against the user's
    // last 30 days of signal titles (case-insensitive substring match) since
    // that extra check isn't needed (and isn't present) on the manual button.
    try {
      const suggestions = await scanForObjectives(userId, supabase);
      const windowStart = new Date(Date.now() - OBJECTIVE_DEDUP_WINDOW_DAYS * 86_400_000).toISOString();
      const { data: recentSignals } = await supabase
        .from("signals")
        .select("title")
        .eq("user_id", userId)
        .gte("created_at", windowStart);
      const recentLower = (recentSignals ?? []).map((s) => (s.title as string).toLowerCase());

      let inserted = 0;
      for (const sug of suggestions) {
        const targetLower = sug.target.toLowerCase();
        // Guard empty strings — "".includes(x) is false but x.includes("") is always
        // true, which would make a blank existing title swallow every suggestion.
        const isDuplicate = targetLower.length > 0 && recentLower.some((t) => t.length > 0 && (t.includes(targetLower) || targetLower.includes(t)));
        if (isDuplicate) continue;
        const { error } = await supabase.from("signals").insert({
          user_id: userId,
          title: sug.target,
          body: `Surfaced from ${sug.module} · confidence: ${sug.confidence}`,
          source: "Objectives",
          signal_type: "fyi",
        });
        if (!error) {
          inserted += 1;
          recentLower.push(targetLower); // avoid inserting near-duplicates of each other within this same run
        }
      }
      userResult.objectives_scan = { suggested: suggestions.length, inserted };
    } catch (e) {
      userResult.objectives_scan = { error: String(e) };
    }

    // (c) Debrief staleness — only nudge users who have used the feature before.
    try {
      const { data: lastDebrief } = await supabase
        .from("notes")
        .select("created_at")
        .eq("user_id", userId)
        .eq("folder", "Debrief")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

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
          userResult.debrief = error ? { inserted: false, reason: error.message } : { inserted: true };
        } else {
          userResult.debrief = { inserted: false, reason: `last debrief ${Math.floor(ageDays)}d ago — not stale yet` };
        }
      }
    } catch (e) {
      userResult.debrief = { error: String(e) };
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
        userResult.literature_watch = error ? { inserted: false, reason: error.message } : { inserted: true, newPapers: newPapers.length };
      }
    } catch (e) {
      userResult.literature_watch = { error: String(e) };
    }

    // (e) Pipeline deadline watch — nudges when a conference's abstract is due
    // within the next 7 days. No upper-bound-only check on the past side: a
    // conference that's already overdue (e.g. the cron missed a day, or the
    // date was set with under a week's notice) still gets flagged, since the
    // per-conference dedup below means this can only ever fire once — better
    // a one-time late nudge than silently never notifying about a missed date.
    try {
      const { data: conferences } = await supabase
        .from("conferences")
        .select("id, name, abstract_due_date")
        .eq("user_id", userId)
        .not("abstract_due_date", "is", null);

      const upcoming = (conferences ?? []).filter((c) => {
        const due = new Date(c.abstract_due_date as string).getTime();
        const daysOut = (due - Date.now()) / 86_400_000;
        return daysOut <= ABSTRACT_DUE_WINDOW_DAYS;
      });

      let inserted = 0;
      for (const c of upcoming) {
        const { data: existing } = await supabase
          .from("signals")
          .select("id")
          .eq("user_id", userId)
          .eq("source", "Pipeline")
          .contains("metadata", { conference_id: c.id })
          .limit(1)
          .maybeSingle();
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
        if (!error) inserted += 1;
      }
      userResult.pipeline_deadlines = { inserted };
    } catch (e) {
      userResult.pipeline_deadlines = { error: String(e) };
    }

    results[userId] = userResult;
  }

  return NextResponse.json({ ok: true, results });
}
