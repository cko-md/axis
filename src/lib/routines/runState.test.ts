import { describe, expect, it } from "vitest";
import {
  assertRunTransition,
  assertStepTransition,
  canRunTransition,
  canStepTransition,
  deriveRunOutcome,
  isRunTerminal,
  isStepTerminal,
} from "./runState";

describe("routine run state machine", () => {
  it("allows the happy path and blocks illegal run transitions", () => {
    expect(canRunTransition("queued", "running")).toBe(true);
    expect(canRunTransition("running", "completed")).toBe(true);
    expect(canRunTransition("running", "waiting_for_approval")).toBe(true);
    expect(canRunTransition("waiting_for_approval", "running")).toBe(true);
    // illegal: reviving a terminal run, or skipping straight to completed.
    expect(canRunTransition("completed", "running")).toBe(false);
    expect(canRunTransition("queued", "completed")).toBe(false);
  });

  it("marks the right run statuses terminal", () => {
    for (const s of ["completed", "partial", "failed", "cancelled"] as const) {
      expect(isRunTerminal(s)).toBe(true);
    }
    for (const s of ["queued", "running", "waiting_for_approval", "blocked"] as const) {
      expect(isRunTerminal(s)).toBe(false);
    }
  });

  it("governs step transitions", () => {
    expect(canStepTransition("pending", "running")).toBe(true);
    expect(canStepTransition("running", "succeeded")).toBe(true);
    expect(canStepTransition("running", "failed")).toBe(true);
    expect(canStepTransition("pending", "skipped")).toBe(true);
    expect(canStepTransition("succeeded", "running")).toBe(false);
    expect(isStepTerminal("succeeded")).toBe(true);
    expect(isStepTerminal("pending")).toBe(false);
  });

  it("assert* throws on illegal transitions", () => {
    expect(() => assertRunTransition("completed", "running")).toThrow(/Illegal run transition/);
    expect(() => assertStepTransition("succeeded", "failed")).toThrow(/Illegal step transition/);
    expect(() => assertRunTransition("queued", "running")).not.toThrow();
  });

  it("derives the run outcome from step results", () => {
    expect(deriveRunOutcome([])).toBe("completed");
    expect(deriveRunOutcome(["succeeded", "succeeded"])).toBe("completed");
    expect(deriveRunOutcome(["succeeded", "skipped"])).toBe("completed");
    expect(deriveRunOutcome(["succeeded", "failed"])).toBe("partial");
    expect(deriveRunOutcome(["failed", "failed"])).toBe("failed");
    expect(deriveRunOutcome(["skipped"])).toBe("completed");
  });
});
