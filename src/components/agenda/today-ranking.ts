import { rankTasks, type Task } from "@/lib/hooks/useTasks";
import { personFootLabel, type Person } from "@/lib/hooks/usePeople";
import type { ScheduleEvent } from "@/lib/types";
import { eventOccursOnLocalDay } from "@/lib/calendar/event-dates";

// CAL-4: merges today's calendar events, open/overdue tasks, and due People
// follow-ups into one ranked "Today" list. Pure and unit-testable so the
// ranking rules (events-first-by-time, then tasks by rankTasks score, then
// due follow-ups) can be verified without mounting AgendaModule.

export type TodayItem =
  | { kind: "event"; id: string; title: string; time: string; source: ScheduleEvent }
  | { kind: "task"; id: string; title: string; priority: Task["priority"]; source: Task }
  | { kind: "follow-up"; id: string; title: string; footLabel: string; source: Person };

function isTodayEvent(event: ScheduleEvent, now: Date): boolean {
  return eventOccursOnLocalDay(event.start_at, Boolean(event.all_day), now);
}

function eventTime(event: ScheduleEvent): string {
  if (event.all_day) return "All day";
  const d = new Date(event.start_at);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

// Ranked, capped list for the Today section. Events for today (by start
// time) lead, since they're time-fixed and can't be reordered around;
// open/overdue tasks follow in rankTasks priority×deadline order; due People
// follow-ups close it out. `limit` caps total items shown (0/undefined = no cap).
export function buildTodayRanking(
  events: ScheduleEvent[],
  tasks: Task[],
  duePeople: Person[],
  now: Date = new Date(),
  limit?: number,
): TodayItem[] {
  const todaysEvents = [...events]
    .filter((e) => isTodayEvent(e, now))
    .sort((a, b) => a.start_at.localeCompare(b.start_at))
    .map<TodayItem>((event) => ({ kind: "event", id: event.id, title: event.title, time: eventTime(event), source: event }));

  const rankedTasks = rankTasks(tasks.filter((t) => t.status !== "done"))
    .map<TodayItem>((task) => ({ kind: "task", id: task.id, title: task.title, priority: task.priority, source: task }));

  const followUps = duePeople.map<TodayItem>((person) => ({
    kind: "follow-up",
    id: person.id,
    title: person.name,
    footLabel: personFootLabel(person, now),
    source: person,
  }));

  const merged = [...todaysEvents, ...rankedTasks, ...followUps];
  return limit && limit > 0 ? merged.slice(0, limit) : merged;
}
