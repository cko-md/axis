import { describe, expect, it } from "vitest";
import { isRunComplete, isStepAlreadyDone, planResume, type ExistingStep } from "./runner";

const KEYS = ["load_holdings", "review_concentration", "create_tasks"] as const;

describe("planResume", () => {
  it("runs everything on a fresh run", () => {
    const plan = planResume(KEYS, []);
    expect(plan.toRun).toEqual([...KEYS]);
    expect(plan.reuse).toEqual({});
  });

  it("skips succeeded steps and reuses their output (resume after failure)", () => {
    const existing: ExistingStep[] = [
      { step_key: "load_holdings", status: "succeeded", output_snapshot: [{ symbol: "AAPL" }] },
      { step_key: "review_concentration", status: "succeeded", output_snapshot: { breaches: 1 } },
      { step_key: "create_tasks", status: "failed" },
    ];
    const plan = planResume(KEYS, existing);
    expect(plan.toRun).toEqual(["create_tasks"]);
    expect(plan.reuse.load_holdings).toEqual([{ symbol: "AAPL" }]);
    expect(plan.reuse.review_concentration).toEqual({ breaches: 1 });
  });

  it("preserves declared order for the steps still to run", () => {
    const existing: ExistingStep[] = [{ step_key: "review_concentration", status: "succeeded" }];
    expect(planResume(KEYS, existing).toRun).toEqual(["load_holdings", "create_tasks"]);
  });

  it("treats a key as done if any of its records succeeded (retry that passed)", () => {
    const existing: ExistingStep[] = [
      { step_key: "load_holdings", status: "failed" },
      { step_key: "load_holdings", status: "succeeded", output_snapshot: 1 },
    ];
    expect(planResume(KEYS, existing).toRun).not.toContain("load_holdings");
    expect(isStepAlreadyDone("load_holdings", existing)).toBe(true);
  });

  it("ignores stale reuse for keys not in the current step set", () => {
    const existing: ExistingStep[] = [{ step_key: "old_step", status: "succeeded", output_snapshot: 9 }];
    expect(planResume(KEYS, existing).reuse).toEqual({});
  });
});

describe("isRunComplete", () => {
  it("is true only when every ordered step succeeded", () => {
    const done: ExistingStep[] = KEYS.map((k) => ({ step_key: k, status: "succeeded" as const }));
    expect(isRunComplete(KEYS, done)).toBe(true);
    expect(isRunComplete(KEYS, done.slice(0, 2))).toBe(false);
    expect(isRunComplete([], [])).toBe(false);
  });
});
