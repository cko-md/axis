import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAccessToken, stravaGet, metresToKm, type StravaActivity } from "@/app/api/strava/_lib";
import { logRouteTiming } from "@/lib/observability/providerTiming";

// GET /api/widgets/training
// Live data source for the "run"/Training console widget. Reads the user's
// recent Strava activities and reports this week's banked distance plus a
// day-streak — so the widget reflects real training instead of the static
// "8 km banked / Streak day 8" catalog stub. Degrades gracefully to that stub
// (fallback:true) whenever Strava isn't connected/configured.
export async function GET() {
  const routeStartedAt = Date.now();
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const STUB = { value: "8 km banked", hint: "Connect Strava in Vitality", fallback: true };

  const token = await getAccessToken(user.id);
  if (!token) {
    logRouteTiming("/api/widgets/training", routeStartedAt, { fallback: true, connected: false });
    return NextResponse.json(STUB, { headers: { "Cache-Control": "no-store" } });
  }

  const activities = await stravaGet<StravaActivity[]>(token, "/athlete/activities?per_page=60&page=1").catch(() => null);
  if (!activities || activities.length === 0) {
    logRouteTiming("/api/widgets/training", routeStartedAt, { fallback: !activities });
    return NextResponse.json(
      activities
        ? { value: "0 km banked", hint: "No recent activity · Strava", raw: { km: 0, streak: 0 } }
        : { ...STUB, hint: "Strava refresh failed", error: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  // This week's distance (Monday-anchored, matching the rest of the app's week).
  const now = new Date();
  const weekStart = new Date(now);
  const dow = (weekStart.getDay() + 6) % 7; // 0 = Monday
  weekStart.setHours(0, 0, 0, 0);
  weekStart.setDate(weekStart.getDate() - dow);

  const weekMetres = activities
    .filter((a) => new Date(a.start_date).getTime() >= weekStart.getTime())
    .reduce((sum, a) => sum + (a.distance ?? 0), 0);
  const km = metresToKm(weekMetres);

  // Day-streak: consecutive calendar days (counting back from today) that have
  // at least one activity. Allows the streak to be "current" if today has none
  // yet but yesterday did.
  const activeDays = new Set(
    activities.map((a) => new Date(a.start_date).toISOString().slice(0, 10)),
  );
  const dayKey = (d: Date) => d.toISOString().slice(0, 10);
  let streak = 0;
  const cursor = new Date(now);
  cursor.setHours(0, 0, 0, 0);
  if (!activeDays.has(dayKey(cursor))) cursor.setDate(cursor.getDate() - 1); // grace for "not yet today"
  while (activeDays.has(dayKey(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }

  const hint = streak > 0 ? `Streak day ${streak} · Strava` : "This week · Strava";

  logRouteTiming("/api/widgets/training", routeStartedAt, { fallback: false });
  return NextResponse.json(
    { value: `${km} km banked`, hint, raw: { km, streak } },
    { headers: { "Cache-Control": "s-maxage=600, stale-while-revalidate=1800" } },
  );
}
