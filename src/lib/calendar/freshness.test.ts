import { describe, expect, it } from "vitest";
import { formatCalendarFreshness } from "@/lib/calendar/freshness";

describe("formatCalendarFreshness", () => {
  const now = new Date("2026-07-02T12:00:00.000Z").getTime();

  it("returns null when there is no fetch timestamp yet", () => {
    expect(formatCalendarFreshness(null, false, now)).toBeNull();
  });

  it("returns null for an unparseable timestamp", () => {
    expect(formatCalendarFreshness("not-a-date", false, now)).toBeNull();
  });

  it("labels a live (non-cache) fetch", () => {
    expect(formatCalendarFreshness("2026-07-02T11:58:00.000Z", false, now)).toBe("Calendar synced 2 minutes ago");
  });

  it("labels a cache-first paint distinctly from a live fetch", () => {
    expect(formatCalendarFreshness("2026-07-02T11:50:00.000Z", true, now)).toBe(
      "Showing cached calendar events · last synced 10 minutes ago",
    );
  });

  it("rounds sub-minute freshness to 'just now'", () => {
    expect(formatCalendarFreshness("2026-07-02T11:59:45.000Z", false, now)).toBe("Calendar synced just now");
  });

  it("uses singular phrasing for exactly one minute", () => {
    expect(formatCalendarFreshness("2026-07-02T11:59:00.000Z", false, now)).toBe("Calendar synced 1 minute ago");
  });

  it("switches to hour granularity past 60 minutes", () => {
    expect(formatCalendarFreshness("2026-07-02T09:30:00.000Z", false, now)).toBe("Calendar synced 2h ago");
  });

  it("never reports negative age for a future timestamp (clock skew)", () => {
    expect(formatCalendarFreshness("2026-07-02T12:05:00.000Z", false, now)).toBe("Calendar synced just now");
  });
});
