// Pure freshness-label formatting for the Schedule external-calendar
// cache-first paint (CAL-3) — kept separate from ScheduleModule so the
// relative-time text is unit-testable without mounting the component.

export function formatCalendarFreshness(fetchedAtIso: string | null, fromCache: boolean, now: number = Date.now()): string | null {
  if (!fetchedAtIso) return null;
  const fetchedAt = new Date(fetchedAtIso).getTime();
  if (Number.isNaN(fetchedAt)) return null;

  const ageMs = Math.max(0, now - fetchedAt);
  const ageMinutes = Math.floor(ageMs / 60000);

  const relative = ageMinutes < 1
    ? "just now"
    : ageMinutes === 1
      ? "1 minute ago"
      : ageMinutes < 60
        ? `${ageMinutes} minutes ago`
        : `${Math.floor(ageMinutes / 60)}h ago`;

  return fromCache
    ? `Showing cached calendar events · last synced ${relative}`
    : `Calendar synced ${relative}`;
}
