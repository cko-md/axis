import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  let openTasks = 0;
  let eventsToday = 0;
  let nextTitle = "No upcoming events";

  if (user) {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date(todayStart);
    todayEnd.setDate(todayEnd.getDate() + 1);

    const [{ count: taskCount }, { data: events }] = await Promise.all([
      supabase.from("tasks").select("*", { count: "exact", head: true }).eq("user_id", user.id).eq("status", "open"),
      supabase
        .from("schedule_events")
        .select("title, start_at")
        .eq("user_id", user.id)
        .gte("start_at", todayStart.toISOString())
        .lt("start_at", todayEnd.toISOString())
        .order("start_at", { ascending: true })
        .limit(5),
    ]);

    openTasks = taskCount ?? 0;
    eventsToday = events?.length ?? 0;
    const upcoming = events?.find((e) => new Date(e.start_at) > new Date());
    if (upcoming) {
      const mins = Math.round((new Date(upcoming.start_at).getTime() - Date.now()) / 60000);
      nextTitle = mins > 0 ? `${upcoming.title} in ${mins < 60 ? `${mins}m` : `${Math.round(mins / 60)}h`}` : upcoming.title;
    }
  }

  return NextResponse.json({
    value: `${eventsToday} events · ${openTasks} tasks`,
    hint: `Next: ${nextTitle}`,
    raw: { eventsToday, openTasks },
  });
}
