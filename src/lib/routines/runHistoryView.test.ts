import { describe, expect, it } from "vitest";
import {
  formatRoutineKey,
  jsonPreview,
  routineRunStatusLabel,
  routineRunTone,
  summarizeRoutineOutput,
} from "./runHistoryView";

describe("routine run history presenter", () => {
  it("labels and tones run statuses", () => {
    expect(routineRunStatusLabel("waiting_for_approval")).toBe("Waiting for approval");
    expect(routineRunTone("completed")).toBe("done");
    expect(routineRunTone("waiting_for_approval")).toBe("waiting");
    expect(routineRunTone("partial")).toBe("blocked");
    expect(routineRunTone("failed")).toBe("failed");
  });

  it("formats routine keys for display", () => {
    expect(formatRoutineKey("concentration_review")).toBe("Concentration Review");
  });

  it("summarizes known output shapes without fabricating metrics", () => {
    expect(summarizeRoutineOutput({ orders: [{ id: 1 }, { id: 2 }] })).toBe("2 order proposals");
    expect(summarizeRoutineOutput({ created: [{ id: 1 }], breaches: 1 })).toBe("1 task created");
    expect(summarizeRoutineOutput({ breaches: 0 })).toBe("No breaches");
    expect(summarizeRoutineOutput(null)).toBe("No output");
  });

  it("truncates JSON previews deterministically", () => {
    expect(jsonPreview({ a: "x".repeat(50) }, 32)).toContain("... truncated");
  });
});
