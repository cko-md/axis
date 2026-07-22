import { describe, expect, it } from "vitest";
import { buildHeroSentence, timeOfDay, type HeroContext } from "@/lib/console/heroLine";

const BASE: HeroContext = {
  openCount: 6,
  overdueCount: 0,
  dueTodayCount: 0,
  doneTodayCount: 0,
  nextEvent: null,
  hour: 9,
  daySeed: 20_656,
};

function line(ctx: Partial<HeroContext>) {
  const result = buildHeroSentence({ ...BASE, ...ctx });
  if (result.kind !== "line") throw new Error(`expected line, got ${result.kind}`);
  return result;
}

describe("timeOfDay", () => {
  it("buckets the local hour", () => {
    expect(timeOfDay(2)).toBe("late");
    expect(timeOfDay(5)).toBe("morning");
    expect(timeOfDay(11)).toBe("morning");
    expect(timeOfDay(12)).toBe("afternoon");
    expect(timeOfDay(17)).toBe("afternoon");
    expect(timeOfDay(18)).toBe("evening");
    expect(timeOfDay(23)).toBe("evening");
  });
});

describe("buildHeroSentence", () => {
  it("returns the first-run marker only when nothing is open AND nothing was done today", () => {
    expect(buildHeroSentence({ ...BASE, openCount: 0 }).kind).toBe("first-run");
    expect(buildHeroSentence({ ...BASE, openCount: 0, doneTodayCount: 2 }).kind).toBe("line");
  });

  it("celebrates a cleared board with the done-today count", () => {
    const s = line({ openCount: 0, doneTodayCount: 3, hour: 20 });
    expect(s.lead).toBe("A clean board");
    expect(s.em).toBe("3 closed today");
  });

  it("emphasizes overdue above everything else", () => {
    const s = line({ overdueCount: 2, dueTodayCount: 4, doneTodayCount: 1 });
    expect(s.em).toBe("2 overdue");
  });

  it("points the tail at the overdue debt during working hours", () => {
    const s = line({ overdueCount: 1, hour: 10 });
    expect(s.tail).toMatch(/overdue|debt|slipped/);
  });

  it("does not nudge toward overdue work in the middle of the night", () => {
    const s = line({ overdueCount: 1, hour: 3 });
    expect(s.tail).not.toMatch(/overdue first|debt first|slipped/);
  });

  it("falls back to due-today, then done-today, then a neutral emphasis", () => {
    expect(line({ dueTodayCount: 2 }).em).toBe("2 due today");
    expect(line({ doneTodayCount: 5 }).em).toBe("5 closed today");
    expect(line({}).em).toMatch(/nothing overdue|a clear runway|no deadlines pressing/);
  });

  it("references an imminent calendar event in the tail", () => {
    const s = line({
      nextEvent: { title: "Design review", minutesUntil: 45, timeLabel: "10:30 AM" },
    });
    expect(s.tail).toContain("Design review");
    expect(s.tail).toContain("10:30 AM");
  });

  it("ignores events that are too far away or already starting", () => {
    const far = line({ nextEvent: { title: "Dinner", minutesUntil: 400, timeLabel: "7:00 PM" } });
    expect(far.tail).not.toContain("Dinner");
    const now = line({ nextEvent: { title: "Standup", minutesUntil: 3, timeLabel: "9:05 AM" } });
    expect(now.tail).not.toContain("Standup");
  });

  it("varies the tail with the time of day", () => {
    const morning = line({ hour: 8 });
    const evening = line({ hour: 21 });
    expect(morning.tail).not.toBe(evening.tail);
  });

  it("is deterministic for identical context", () => {
    expect(line({})).toEqual(line({}));
  });

  it("rotates phrasing across days", () => {
    const tails = new Set(
      Array.from({ length: 10 }, (_, i) => line({ daySeed: BASE.daySeed + i }).tail),
    );
    expect(tails.size).toBeGreaterThan(1);
  });

  it("pluralizes the open-task lead", () => {
    expect(line({ openCount: 1 }).lead).toBe("1 open task");
    expect(line({ openCount: 6 }).lead).toBe("6 open tasks");
  });
});
