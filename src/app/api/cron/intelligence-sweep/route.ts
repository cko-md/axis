import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { scanPlatformForUser } from "@/lib/signals/scan";
import { scanForObjectives } from "@/lib/objectives/scan";

const DEBRIEF_STALE_DAYS = 6;
const OBJECTIVE_DEDUP_WINDOW_DAYS = 30;

type UserSweepResult = {
  platform_scan?: { created: number } | { error: string };
  objectives_scan?: { suggested: number; inserted: number } | { error: string };
  debrief?: { inserted: boolean; reason?: string } | { error: string };
};

// Make-triggered consolidated daily sweep: per-user platform scan, objectives
// scan (with its own signal-insertion + dedup on top of the shared lib
// function), and debrief-staleness nudge. One user's failure never aborts the
// rest — each step is independently wrapped.
//
// Auth: bearer MAKE_SWEEP_SECRET (a dedicated secret for this Make-triggered
// channel — NOT the Vercel-cron CRON_SECRET used by /api/cron/daily).
// Uses the service-role admin client to cross user boundaries directly
// (bypasses RLS) — no SECURITY DEFINER RPCs needed, unlike /api/cron/daily.
export async function POST(req: NextRequest) {
  if (!process.env.MAKE_SWEEP_SECRET) {
    return NextResponse.json({ error: "MAKE_SWEEP_SECRET not configured" }, { status: 503 });
  }
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.MAKE_SWEEP_SECRET}`) {
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

    results[userId] = userResult;
  }

  return NextResponse.json({ ok: true, results });
}
