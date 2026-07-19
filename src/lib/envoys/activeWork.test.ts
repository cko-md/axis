import { describe, expect, it } from "vitest";
import { projectEnvoyActiveWork } from "@/lib/envoys/activeWork";

const OK_EMPTY = { ok: true as const, rows: [] };

describe("envoy active-work projection", () => {
  it("returns honest empty sections when every source succeeds with no rows", () => {
    const work = projectEnvoyActiveWork({ tasks: OK_EMPTY, approvals: OK_EMPTY, runs: OK_EMPTY });
    expect(work.ranked).toEqual([]);
    expect(work.attentionCount).toBe(0);
    expect(work.degradedSections).toEqual([]);
  });

  it("marks a failed section degraded instead of empty and excludes it from counts", () => {
    const work = projectEnvoyActiveWork({
      tasks: { ok: false, code: "TASKS_UNAVAILABLE" },
      approvals: OK_EMPTY,
      runs: OK_EMPTY,
    });
    expect(work.tasks).toEqual({ status: "degraded", code: "TASKS_UNAVAILABLE" });
    expect(work.degradedSections).toEqual(["tasks"]);
    expect(work.attentionCount).toBe(0);
  });

  it("filters terminal tasks and resolved approvals, keeping only live work", () => {
    const work = projectEnvoyActiveWork({
      tasks: {
        ok: true,
        rows: [
          { id: "t1", objective: "Review drift", status: "queued", updated_at: "2026-07-18T10:00:00Z" },
          { id: "t2", objective: "Done thing", status: "completed", updated_at: "2026-07-18T11:00:00Z" },
        ],
      },
      approvals: {
        ok: true,
        rows: [
          { id: "a1", proposed_action: { summary: "Sell 3 VTI" }, status: "pending", created_at: "2026-07-18T09:00:00Z" },
          { id: "a2", proposed_action: { summary: "Old" }, status: "executed", created_at: "2026-07-18T08:00:00Z" },
        ],
      },
      runs: {
        ok: true,
        rows: [
          { id: "r1", routine_key: "rebalance-proposal", status: "waiting_for_approval", started_at: "2026-07-18T07:00:00Z" },
          { id: "r2", routine_key: "concentration-check", status: "completed", started_at: "2026-07-18T06:00:00Z" },
        ],
      },
    });
    expect(work.ranked.map((item) => item.id)).toEqual(["a1", "r1", "t1"]);
    expect(work.ranked[0].statusLabel).toBe("Needs decision");
    expect(work.attentionCount).toBe(2); // pending approval (0) + waiting run (1); queued task rank 4 excluded
  });

  it("ranks deterministically: urgency, then newest, then id", () => {
    const work = projectEnvoyActiveWork({
      tasks: {
        ok: true,
        rows: [
          { id: "t-old", objective: "Old exec", status: "executing", updated_at: "2026-07-18T01:00:00Z" },
          { id: "t-new", objective: "New exec", status: "executing", updated_at: "2026-07-18T02:00:00Z" },
          { id: "t-b", objective: "Tie B", status: "queued", updated_at: "2026-07-18T03:00:00Z" },
          { id: "t-a", objective: "Tie A", status: "queued", updated_at: "2026-07-18T03:00:00Z" },
        ],
      },
      approvals: OK_EMPTY,
      runs: OK_EMPTY,
    });
    expect(work.ranked.map((item) => item.id)).toEqual(["t-new", "t-old", "t-a", "t-b"]);
  });

  it("never fabricates titles, timestamps, or progress", () => {
    const work = projectEnvoyActiveWork({
      tasks: { ok: true, rows: [{ id: "t1", objective: "  ", status: "queued", updated_at: "garbage" }] },
      approvals: OK_EMPTY,
      runs: OK_EMPTY,
    });
    expect(work.ranked[0].title).toBe("Task");
    expect(work.ranked[0].updatedAt).toBe("");
    expect(JSON.stringify(work)).not.toMatch(/percent|progress/i);
  });

  it("deep-links every item to the surface that owns it", () => {
    const work = projectEnvoyActiveWork({
      tasks: { ok: true, rows: [{ id: "t1", objective: "x", status: "queued" }] },
      approvals: { ok: true, rows: [{ id: "a1", status: "pending" }] },
      runs: { ok: true, rows: [{ id: "r1", status: "running" }] },
    });
    const hrefs = Object.fromEntries(work.ranked.map((item) => [item.kind, item.href]));
    expect(hrefs).toEqual({ approval: "/approvals", task: "/tasks", run: "/tasks" });
  });
});
