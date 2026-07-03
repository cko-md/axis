import { describe, expect, it } from "vitest";
import { buildTodayRanking } from "@/components/agenda/today-ranking";
import type { Task } from "@/lib/hooks/useTasks";
import type { Person } from "@/lib/hooks/usePeople";
import type { ScheduleEvent } from "@/lib/types";

const NOW = new Date("2026-07-02T12:00:00.000Z");

function task(overrides: Partial<Task>): Task {
  return {
    id: "t1", user_id: "u1", title: "Task", priority: "med", effort: null, deadline: null,
    category: "research", status: "open", sort_order: 0, metadata: {},
    created_at: NOW.toISOString(), updated_at: NOW.toISOString(), completed_at: null,
    ...overrides,
  };
}

function person(overrides: Partial<Person>): Person {
  return {
    id: "p1", user_id: "u1", name: "Jane", role: "Mentor", note: "", tag: "mentor",
    last_contact_on: null, follow_up_on: null, created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
    ...overrides,
  };
}

function event(overrides: Partial<ScheduleEvent>): ScheduleEvent {
  return {
    id: "e1", title: "Event", start_at: NOW.toISOString(), end_at: NOW.toISOString(), color_class: "a",
    ...overrides,
  };
}

describe("buildTodayRanking", () => {
  it("orders today's events before tasks before follow-ups", () => {
    const result = buildTodayRanking(
      [event({ id: "e1", title: "Standup", start_at: "2026-07-02T09:00:00.000Z" })],
      [task({ id: "t1", title: "Write report", priority: "hi" })],
      [person({ id: "p1", name: "Jane", follow_up_on: "2026-07-01" })],
      NOW,
    );
    expect(result.map((r) => r.kind)).toEqual(["event", "task", "follow-up"]);
  });

  it("excludes events from other days", () => {
    const result = buildTodayRanking(
      [
        event({ id: "e1", start_at: "2026-07-02T09:00:00.000Z" }),
        event({ id: "e2", start_at: "2026-07-03T09:00:00.000Z" }),
      ],
      [],
      [],
      NOW,
    );
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("e1");
  });

  it("sorts today's events chronologically", () => {
    const result = buildTodayRanking(
      [
        event({ id: "late", start_at: "2026-07-02T15:00:00.000Z" }),
        event({ id: "early", start_at: "2026-07-02T08:00:00.000Z" }),
      ],
      [],
      [],
      NOW,
    );
    expect(result.map((r) => r.id)).toEqual(["early", "late"]);
  });

  it("excludes done tasks and ranks open tasks by priority×deadline (not insertion order)", () => {
    const result = buildTodayRanking(
      [],
      [
        task({ id: "low", priority: "lo" }),
        task({ id: "done", status: "done" }),
        task({ id: "hi", priority: "hi" }),
      ],
      [],
      NOW,
    );
    expect(result.map((r) => r.id)).toEqual(["hi", "low"]);
  });

  it("caps the merged list at the given limit", () => {
    const result = buildTodayRanking(
      [event({ id: "e1" })],
      [task({ id: "t1" }), task({ id: "t2" })],
      [person({ id: "p1" })],
      NOW,
      2,
    );
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.id)).toEqual(["e1", "t1"]);
  });

  it("returns an empty list when there is nothing today (real empty state)", () => {
    expect(buildTodayRanking([], [], [], NOW)).toEqual([]);
  });
});
