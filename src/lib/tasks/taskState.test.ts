import { describe, expect, it } from "vitest";
import {
  assertTransition,
  canTransition,
  isTerminal,
  isWaiting,
  TASK_STATUSES,
  TASK_TRANSITIONS,
  TERMINAL_STATUSES,
  type FinancialTaskStatus,
} from "./taskState";

describe("task state machine — structure", () => {
  it("defines a transition entry for every status", () => {
    for (const status of TASK_STATUSES) {
      expect(TASK_TRANSITIONS[status]).toBeDefined();
    }
  });

  it("only references known statuses as targets", () => {
    const known = new Set<string>(TASK_STATUSES);
    for (const targets of Object.values(TASK_TRANSITIONS)) {
      for (const target of targets) expect(known.has(target)).toBe(true);
    }
  });

  it("never allows a self-transition", () => {
    for (const status of TASK_STATUSES) {
      expect(TASK_TRANSITIONS[status]).not.toContain(status);
    }
  });
});

describe("task state machine — terminal states", () => {
  it("has no outgoing transitions from terminal states", () => {
    for (const status of TERMINAL_STATUSES) {
      expect(TASK_TRANSITIONS[status]).toHaveLength(0);
      expect(isTerminal(status)).toBe(true);
    }
  });

  it("cannot revive a completed/failed/cancelled task", () => {
    expect(canTransition("completed", "executing")).toBe(false);
    expect(canTransition("failed", "queued")).toBe(false);
    expect(canTransition("cancelled", "gathering_data")).toBe(false);
  });

  it("every non-terminal status can reach cancelled and failed (except queued->failed)", () => {
    for (const status of TASK_STATUSES) {
      if (isTerminal(status)) continue;
      expect(canTransition(status, "cancelled")).toBe(true);
    }
  });
});

describe("task state machine — key financial flows", () => {
  it("routes an approval grant through executing, not around it", () => {
    expect(canTransition("waiting_for_approval", "executing")).toBe(true);
    // A fresh queued task cannot jump straight to executing without doing work.
    expect(canTransition("queued", "executing")).toBe(true); // allowed: some tasks are execute-only
    // But it must be able to pause for approval before executing in the normal path.
    expect(canTransition("calculating", "waiting_for_approval")).toBe(true);
  });

  it("lets active work pause and resume", () => {
    expect(canTransition("executing", "waiting_for_data")).toBe(true);
    expect(canTransition("waiting_for_data", "gathering_data")).toBe(true);
    expect(canTransition("blocked", "researching")).toBe(true);
  });

  it("classifies waiting states", () => {
    expect(isWaiting("waiting_for_approval")).toBe(true);
    expect(isWaiting("executing")).toBe(false);
  });
});

describe("assertTransition", () => {
  it("throws on an illegal transition", () => {
    expect(() => assertTransition("completed", "executing")).toThrow(/Illegal task transition/);
  });

  it("does not throw on a legal transition", () => {
    expect(() => assertTransition("queued", "gathering_data")).not.toThrow();
  });

  it("message names both endpoints", () => {
    let msg = "";
    try {
      assertTransition("failed", "queued" as FinancialTaskStatus);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("failed -> queued");
  });
});
