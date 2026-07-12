/**
 * General-purpose local calendar-day helpers.
 *
 * These live here (rather than under `lib/calendar/`) because "what local day
 * is it?" is a concern for many modules — Agenda, People, Signals, Schedule,
 * Debrief, Control Room — that are not calendar-specific. `lib/calendar/event-dates`
 * re-exports them for calendar callers and backward compatibility.
 */

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
