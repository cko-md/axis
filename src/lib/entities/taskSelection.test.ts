import { describe, expect, it } from "vitest";
import { resolveTaskSelection, taskSelectionHref } from "@/lib/entities/taskSelection";

const TASK_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_ID = "44444444-4444-4444-8444-444444444444";

describe("resolveTaskSelection", () => {
  it("has no selection when the task query is absent", () => {
    expect(resolveTaskSelection(null, [TASK_ID], true)).toEqual({ status: "none" });
  });

  it("rejects malformed and wrong-kind entity references", () => {
    expect(resolveTaskSelection("task:not-a-uuid", [TASK_ID], true)).toEqual({ status: "invalid" });
    expect(resolveTaskSelection(`note:${TASK_ID}`, [TASK_ID], true)).toEqual({ status: "invalid" });
  });

  it("waits for the owner-scoped task list before deciding membership", () => {
    expect(resolveTaskSelection(`task:${TASK_ID}`, [], false)).toEqual({
      status: "pending",
      ref: { kind: "task", id: TASK_ID },
    });
  });

  it("returns the same not-found state for every ID absent from the owner list", () => {
    expect(resolveTaskSelection(`task:${OTHER_ID}`, [TASK_ID], true)).toEqual({
      status: "not_found",
      ref: { kind: "task", id: OTHER_ID },
    });
  });

  it("selects exactly the referenced owner-loaded task", () => {
    expect(resolveTaskSelection(`task:${OTHER_ID}`, [TASK_ID, OTHER_ID], true)).toEqual({
      status: "ready",
      ref: { kind: "task", id: OTHER_ID },
    });
  });
});

describe("taskSelectionHref", () => {
  it("sets the canonical task reference without dropping workspace or unrelated params", () => {
    const href = taskSelectionHref(
      "/tasks",
      "ws=workspace-state&view=compact&task=task%3A33333333-3333-4333-8333-333333333333",
      OTHER_ID,
    );

    expect(href).toBe(
      "/tasks?ws=workspace-state&view=compact&task=task%3A44444444-4444-4444-8444-444444444444",
    );
  });

  it("clears only task selection and avoids a dangling question mark", () => {
    expect(taskSelectionHref("/tasks", "ws=workspace-state&task=bad", null)).toBe(
      "/tasks?ws=workspace-state",
    );
    expect(taskSelectionHref("/tasks", "task=bad", null)).toBe("/tasks");
  });
});
