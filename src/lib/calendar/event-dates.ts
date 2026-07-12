/** Local calendar day as yyyy-mm-dd. */
export function localDayIso(day: Date): string {
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
}

/**
 * Today's local calendar day as yyyy-mm-dd. Prefer this over
 * `new Date().toISOString().slice(0, 10)`, which returns the UTC day and rolls
 * over early for users in negative-UTC timezones (e.g. after 8 PM EDT it
 * reports tomorrow), producing wrong "today" writes and comparisons.
 */
export function todayLocalIso(): string {
  return localDayIso(new Date());
}

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
