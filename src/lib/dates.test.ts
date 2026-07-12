import { describe, expect, it } from "vitest";
import { localDayIso, todayLocalIso } from "./dates";

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
