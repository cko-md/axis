import { localDayIso, todayLocalIso } from "@/lib/dates";

// The general-purpose local-day helpers now live in `@/lib/dates`. They are
// re-exported here so existing `@/lib/calendar/event-dates` imports keep working.
export { localDayIso, todayLocalIso };

export function startOfLocalDay(day = new Date()): Date {
  const start = new Date(day);
  start.setHours(0, 0, 0, 0);
  return start;
}

export function endOfLocalDay(day = new Date()): Date {
  const end = new Date(day);
  end.setHours(23, 59, 59, 999);
  return end;
}

/** Normalize date-only provider values to a stable ISO timestamp. */
export function normalizeAllDayTimestamp(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T00:00:00.000Z`;
  return value;
}

export function eventOccursOnLocalDay(startAt: string, allDay: boolean, day: Date): boolean {
  if (allDay || /^\d{4}-\d{2}-\d{2}$/.test(startAt)) {
    return startAt.slice(0, 10) === localDayIso(day);
  }
  const start = new Date(startAt);
  return start.toDateString() === day.toDateString();
}
