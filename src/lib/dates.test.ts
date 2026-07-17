import { describe, expect, it } from "vitest";
import {
  getBrowserTimeZone,
  localDayIso,
  localDayIsoInTimeZone,
  resolveTimeZone,
  todayLocalIso,
} from "./dates";

describe("localDayIso", () => {
  it("formats a date using local calendar components", () => {
    const d = new Date(2026, 2, 9, 0, 0, 0); // 2026-03-09 local midnight
    expect(localDayIso(d)).toBe("2026-03-09");
  });

  it("uses the local day for an evening time, not the UTC day", () => {
    // 2026-07-12 20:00 local. localDayIso reads local components, so it stays
    // on the 12th even though toISOString() reports the 13th in negative-UTC
    // timezones — the exact bug this helper exists to prevent.
    const evening = new Date(2026, 6, 12, 20, 0, 0);
    expect(localDayIso(evening)).toBe("2026-07-12");
  });

  it("zero-pads single-digit month and day", () => {
    const d = new Date(2026, 0, 5, 12, 0, 0); // 2026-01-05
    expect(localDayIso(d)).toBe("2026-01-05");
  });
});

describe("todayLocalIso", () => {
  it("returns today's local calendar day as yyyy-mm-dd", () => {
    expect(todayLocalIso()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(todayLocalIso()).toBe(localDayIso(new Date()));
  });
});

describe("resolveTimeZone", () => {
  it("returns a valid IANA string unchanged", () => {
    expect(resolveTimeZone("America/New_York")).toBe("America/New_York");
  });

  it("falls back to UTC for empty, whitespace, or non-string values", () => {
    expect(resolveTimeZone("")).toBe("UTC");
    expect(resolveTimeZone("   ")).toBe("UTC");
    expect(resolveTimeZone(undefined)).toBe("UTC");
    expect(resolveTimeZone(null)).toBe("UTC");
    expect(resolveTimeZone(42)).toBe("UTC");
  });
});

describe("getBrowserTimeZone", () => {
  it("returns a string or undefined", () => {
    const tz = getBrowserTimeZone();
    expect(tz === undefined || typeof tz === "string").toBe(true);
  });
});

describe("localDayIsoInTimeZone", () => {
  it("resolves an instant to the correct day per timezone", () => {
    // 2026-07-13T02:00:00Z is 2026-07-12 22:00 in America/New_York (UTC-4),
    // but already 2026-07-13 in UTC — the cross-midnight case.
    const instant = new Date("2026-07-13T02:00:00.000Z");
    expect(localDayIsoInTimeZone(instant, "America/New_York")).toBe("2026-07-12");
    expect(localDayIsoInTimeZone(instant, "UTC")).toBe("2026-07-13");
  });

  it("handles a positive-offset timezone that rolls forward", () => {
    // 2026-07-12T20:00:00Z is 2026-07-13 05:00 in Asia/Tokyo (UTC+9).
    const instant = new Date("2026-07-12T20:00:00.000Z");
    expect(localDayIsoInTimeZone(instant, "Asia/Tokyo")).toBe("2026-07-13");
    expect(localDayIsoInTimeZone(instant, "UTC")).toBe("2026-07-12");
  });

  it("zero-pads month and day", () => {
    const instant = new Date("2026-01-05T12:00:00.000Z");
    expect(localDayIsoInTimeZone(instant, "UTC")).toBe("2026-01-05");
  });
});
