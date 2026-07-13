import { describe, expect, it } from "vitest";
import { TASK_STATUSES, type FinancialTaskStatus } from "./taskState";
import {
  taskStatusGroup,
  taskStatusLabel,
  taskStatusTone,
  taskToneColor,
} from "./taskStatusView";

describe("taskStatusView", () => {
  it("has a non-empty label for every status", () => {
    for (const s of TASK_STATUSES) {
      expect(taskStatusLabel(s).length).toBeGreaterThan(0);
    }
  });

  it("maps tones by lifecycle phase", () => {
    expect(taskStatusTone("queued")).toBe("neutral");
    expect(taskStatusTone("researching")).toBe("active");
    expect(taskStatusTone("waiting_for_approval")).toBe("waiting");
    expect(taskStatusTone("blocked")).toBe("blocked");
    expect(taskStatusTone("completed")).toBe("done");
    expect(taskStatusTone("failed")).toBe("failed");
    expect(taskStatusTone("cancelled")).toBe("failed");
  });

  it("groups statuses coarsely for the filter", () => {
    expect(taskStatusGroup("queued")).toBe("queued");
    expect(taskStatusGroup("calculating")).toBe("active");
    expect(taskStatusGroup("waiting_for_user")).toBe("waiting");
    expect(taskStatusGroup("blocked")).toBe("blocked");
    expect(taskStatusGroup("completed")).toBe("done");
    expect(taskStatusGroup("cancelled")).toBe("done");
  });

  it("returns a color token for every tone", () => {
    const statuses: FinancialTaskStatus[] = [...TASK_STATUSES];
    for (const s of statuses) {
      expect(taskToneColor(taskStatusTone(s))).toMatch(/^var\(/);
    }
  });
});
