import { describe, expect, it } from "vitest";
import { reconciliationView } from "./reconciliationView";

describe("reconciliationView", () => {
  it("returns null for null/undefined (no indicator — honest absence)", () => {
    expect(reconciliationView(null)).toBeNull();
    expect(reconciliationView(undefined)).toBeNull();
  });

  it("marks conflicting as visually distinct (danger)", () => {
    const v = reconciliationView("conflicting");
    expect(v?.tone).toBe("danger");
    expect(v?.color).toBe("var(--down)");
    expect(v?.label).toBe("Conflict");
  });

  it("keeps matched subtle (success) and pending muted", () => {
    expect(reconciliationView("matched")?.tone).toBe("success");
    expect(reconciliationView("pending")?.tone).toBe("muted");
  });

  it("covers every domain state with a label and description", () => {
    for (const state of ["matched", "partial", "conflicting", "missing", "stale", "pending"] as const) {
      const v = reconciliationView(state);
      expect(v?.label).toBeTruthy();
      expect(v?.description).toMatch(/\.$/);
    }
  });
});
