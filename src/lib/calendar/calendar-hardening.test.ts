import { describe, expect, it } from "vitest";
import { eventOccursOnLocalDay, localDayIso, normalizeAllDayTimestamp } from "@/lib/calendar/event-dates";
import { mergeTodayEvents } from "@/lib/calendar/today-events";
import { unwrapEventList } from "@/lib/calendar/composio";

describe("eventOccursOnLocalDay", () => {
  it("matches all-day events by date prefix", () => {
    const day = new Date(2026, 6, 9);
    expect(eventOccursOnLocalDay("2026-07-09", true, day)).toBe(true);
    expect(eventOccursOnLocalDay("2026-07-08", true, day)).toBe(false);
  });

  it("normalizes date-only values to stable ISO timestamps", () => {
    expect(normalizeAllDayTimestamp("2026-07-09")).toBe("2026-07-09T00:00:00.000Z");
  });
});

describe("mergeTodayEvents", () => {
  it("merges owned and cached external events for the same day", () => {
    const day = new Date(2026, 6, 9);
    const merged = mergeTodayEvents(
      [{ id: "1", title: "Owned", start_at: "2026-07-09T15:00:00.000Z", end_at: "2026-07-09T16:00:00.000Z" }],
      [{
        source: "google",
        events: [{
          externalId: "abc",
          title: "External",
          start_at: "2026-07-09",
          end_at: "2026-07-10",
          all_day: true,
        }],
      }],
      day,
    );
    expect(merged).toHaveLength(2);
    expect(merged.some((event) => event.id === "ext-google-abc")).toBe(true);
    expect(localDayIso(day)).toBe("2026-07-09");
  });
});

describe("unwrapEventList", () => {
  it("unwraps nested Composio response envelopes", () => {
    expect(unwrapEventList({ data: { items: [{ id: "1" }] } })).toEqual([{ id: "1" }]);
    expect(unwrapEventList({ response_data: { value: [{ id: "2" }] } })).toEqual([{ id: "2" }]);
    expect(unwrapEventList({ data: [{ id: "3" }] })).toEqual([{ id: "3" }]);
  });
});
