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

/**
 * Resolve a stored IANA timezone string, falling back to "UTC".
 *
 * Server code that needs a user's local day should read the timezone captured
 * on the client (see ThemeProvider / user_preferences.interface_settings.timeZone)
 * and pass it through here so a missing/invalid value degrades to UTC rather
 * than throwing.
 */
export function resolveTimeZone(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0 ? value : "UTC";
}

/**
 * The browser's current IANA timezone (e.g. "America/New_York"), or undefined
 * if it cannot be determined. Safe to call in any environment.
 */
export function getBrowserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The calendar day (yyyy-mm-dd) on which `date` falls when observed in the
 * given IANA timezone. This is the timezone-aware analogue of `localDayIso`:
 * use it in server code (which has no local timezone of its own) to compute a
 * specific user's "today"/day instead of the UTC day.
 */
export function localDayIsoInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value;
  const y = get("year") ?? "0000";
  const m = get("month") ?? "01";
  const d = get("day") ?? "01";
  return `${y}-${m}-${d}`;
}
