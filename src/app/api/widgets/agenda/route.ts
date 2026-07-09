import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import * as Sentry from "@sentry/nextjs";
import { fetchTodayMergedEvents } from "@/lib/calendar/today-events";
import { logRouteTiming } from "@/lib/observability/providerTiming";

export async function GET() {
  const routeStartedAt = Date.now();
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

    const [taskResult, eventsResult] = await Promise.allSettled([
      supabase
        .from("tasks")
        .select("*", { count: "exact", head: true })
        .eq("user_id", user.id)
        .in("status", ["open", "overdue"]),
      fetchTodayMergedEvents(supabase, user.id),
    ]);

    const errors: string[] = [];
    const taskCount = taskResult.status === "fulfilled" ? taskResult.value.count : null;
    if (taskResult.status === "rejected" || (taskResult.status === "fulfilled" && taskResult.value.error)) {
      errors.push("tasks");
    }

    const events = eventsResult.status === "fulfilled" ? eventsResult.value : null;
    if (eventsResult.status === "rejected") {
      errors.push("events");
    }

    openTasks = taskCount ?? 0;
    eventsToday = events?.length ?? 0;
    const upcoming = events?.find((event) => new Date(event.start_at) > new Date());
    if (upcoming) {
      const mins = Math.round((new Date(upcoming.start_at).getTime() - Date.now()) / 60000);
      nextTitle = mins > 0 ? `${upcoming.title} in ${mins < 60 ? `${mins}m` : `${Math.round(mins / 60)}h`}` : upcoming.title;
    }

    if (errors.length) {
      Sentry.addBreadcrumb({
        category: "widget.partial",
        level: "warning",
        message: "Agenda widget partially loaded",
        data: { widget: "agenda", failed: errors.join(",") },
      });
      logRouteTiming("/api/widgets/agenda", routeStartedAt, { partial: true });
      return NextResponse.json({
        value: `${eventsToday} events · ${openTasks} tasks`,
        hint: errors.length === 2 ? "Agenda refresh failed" : `Partial refresh · ${errors.join(", ")}`,
        raw: { eventsToday, openTasks },
        partial: true,
        errors,
      });
    }
  }

  logRouteTiming("/api/widgets/agenda", routeStartedAt, { partial: false });
  return NextResponse.json({
    value: `${eventsToday} events · ${openTasks} tasks`,
    hint: `Next: ${nextTitle}`,
    raw: { eventsToday, openTasks },
  });
}
