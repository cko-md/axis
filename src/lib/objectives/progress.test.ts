import { describe, expect, it } from "vitest";
import { formatProgressEntry, formatProgressTime, netProgress } from "@/lib/objectives/progress";

describe("formatProgressEntry", () => {
  it("labels manual increments and decrements with signed magnitude", () => {
    expect(formatProgressEntry({ delta: 2, source: "manual" })).toBe("Manual +2");
    expect(formatProgressEntry({ delta: -1, source: "manual" })).toBe("Manual −1");
  });

  it("maps known source tags to readable labels", () => {
    expect(formatProgressEntry({ delta: 1, source: "ai_scan" })).toBe("AI scan +1");
    expect(formatProgressEntry({ delta: -3, source: "reset" })).toBe("Reset −3");
  });

  it("capitalizes an unknown source tag", () => {
    expect(formatProgressEntry({ delta: 1, source: "import" })).toBe("Import +1");
  });

  it("uses ± for a zero delta", () => {
    expect(formatProgressEntry({ delta: 0, source: "manual" })).toBe("Manual ±0");
  });
});

describe("formatProgressTime", () => {
  const now = new Date("2026-07-03T12:00:00.000Z").getTime();
  it("renders relative time by age", () => {
    expect(formatProgressTime("2026-07-03T11:59:40.000Z", now)).toBe("just now");
    expect(formatProgressTime("2026-07-03T11:45:00.000Z", now)).toBe("15m ago");
    expect(formatProgressTime("2026-07-03T09:00:00.000Z", now)).toBe("3h ago");
    expect(formatProgressTime("2026-07-01T09:00:00.000Z", now)).toMatch(/Jul/);
  });
  it("returns empty for an unparseable timestamp", () => {
    expect(formatProgressTime("nope", now)).toBe("");
  });
});

describe("netProgress", () => {
  it("sums deltas", () => {
    expect(netProgress([{ delta: 2 }, { delta: -1 }, { delta: 3 }])).toBe(4);
    expect(netProgress([])).toBe(0);
  });
});
