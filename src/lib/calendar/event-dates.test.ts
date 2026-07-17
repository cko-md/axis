import { describe, expect, it } from "vitest";
import {
  endOfLocalDay,
  eventOccursOnLocalDay,
  localDayIso,
  normalizeAllDayTimestamp,
  startOfLocalDay,
  todayLocalIso,
} from "./event-dates";

// localDayIso / todayLocalIso are owned by `@/lib/dates` (see dates.test.ts).
// This suite covers the calendar-specific helpers plus the re-export surface.

describe("event-dates re-exports", () => {
  it("re-exports the local-day helpers from @/lib/dates", () => {
    expect(localDayIso(new Date(2026, 6, 12))).toBe("2026-07-12");
    expect(todayLocalIso()).toBe(localDayIso(new Date()));
  });
});

describe("startOfLocalDay / endOfLocalDay", () => {
  it("startOfLocalDay zeroes the time components", () => {
    const start = startOfLocalDay(new Date(2026, 6, 12, 15, 30, 45, 123));
    expect(start.getHours()).toBe(0);
    expect(start.getMinutes()).toBe(0);
    expect(start.getSeconds()).toBe(0);
    expect(start.getMilliseconds()).toBe(0);
    expect(localDayIso(start)).toBe("2026-07-12");
  });

  it("endOfLocalDay pushes to the last millisecond of the day", () => {
    const end = endOfLocalDay(new Date(2026, 6, 12, 8, 0, 0));
    expect(end.getHours()).toBe(23);
    expect(end.getMinutes()).toBe(59);
    expect(end.getSeconds()).toBe(59);
    expect(end.getMilliseconds()).toBe(999);
    expect(localDayIso(end)).toBe("2026-07-12");
  });

  it("does not mutate the input date", () => {
    const input = new Date(2026, 6, 12, 15, 30, 0);
    startOfLocalDay(input);
    expect(input.getHours()).toBe(15);
  });
});

describe("normalizeAllDayTimestamp", () => {
  it("expands a date-only value to a UTC midnight timestamp", () => {
    expect(normalizeAllDayTimestamp("2026-07-12")).toBe("2026-07-12T00:00:00.000Z");
  });

  it("passes a full timestamp through unchanged", () => {
    expect(normalizeAllDayTimestamp("2026-07-12T15:30:00.000Z")).toBe(
      "2026-07-12T15:30:00.000Z",
    );
  });
});

describe("eventOccursOnLocalDay", () => {
  const day = new Date(2026, 6, 12); // 2026-07-12 local

  it("matches an all-day event on the same local day", () => {
    expect(eventOccursOnLocalDay("2026-07-12", true, day)).toBe(true);
  });

  it("matches a date-only start even when allDay is false", () => {
    expect(eventOccursOnLocalDay("2026-07-12", false, day)).toBe(true);
  });

  it("rejects an all-day event on a different day", () => {
    expect(eventOccursOnLocalDay("2026-07-13", true, day)).toBe(false);
  });

  it("matches a timed event that falls on the local day", () => {
    const timed = new Date(2026, 6, 12, 15, 0, 0).toISOString();
    expect(eventOccursOnLocalDay(timed, false, day)).toBe(true);
  });
});
