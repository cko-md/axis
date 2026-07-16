import { describe, expect, it } from "vitest";
import {
  bySeverity,
  deriveQueueSeverity,
  deriveSeverity,
  isDuplicateSignal,
  normalizeSignalKey,
  SEVERITY_ORDER,
  type SignalSeverity,
} from "./severity";

describe("deriveSeverity", () => {
  it("maps action/awaiting to actionable", () => {
    expect(deriveSeverity({ signalType: "action" })).toBe("actionable");
    expect(deriveSeverity({ signalType: "awaiting" })).toBe("actionable");
    expect(deriveSeverity({ signalType: "AWAITING" })).toBe("actionable");
  });

  it("maps fyi and unknowns to informational", () => {
    expect(deriveSeverity({ signalType: "fyi" })).toBe("informational");
    expect(deriveSeverity({ signalType: "something-else" })).toBe("informational");
    expect(deriveSeverity({})).toBe("informational");
  });

  it("escalates urgent linked priority to critical", () => {
    expect(deriveSeverity({ signalType: "fyi", priority: "urgent" })).toBe("critical");
    expect(deriveSeverity({ signalType: "action", priority: "P1" })).toBe("critical");
    expect(deriveSeverity({ signalType: "fyi", priority: 0 })).toBe("critical");
    expect(deriveSeverity({ signalType: "fyi", priority: 1 })).toBe("critical");
    expect(deriveSeverity({ signalType: "action", priority: "hi" })).toBe("critical");
  });

  it("does not escalate normal priorities", () => {
    expect(deriveSeverity({ signalType: "action", priority: "medium" })).toBe("actionable");
    expect(deriveSeverity({ signalType: "fyi", priority: 3 })).toBe("informational");
  });

  it("treats redundant duplicates as noise, overriding everything else", () => {
    expect(deriveSeverity({ signalType: "action", priority: "urgent", isRedundant: true })).toBe("noise");
  });
});

describe("deriveQueueSeverity", () => {
  it("demotes a resurfaced resolved title to noise", () => {
    expect(deriveQueueSeverity(
      { title: "Quarterly rebalance!", signalType: "action", priority: "hi" },
      ["Quarterly rebalance"],
    )).toBe("noise");
  });

  it("keeps novel signals in their deterministic tier", () => {
    expect(deriveQueueSeverity(
      { title: "New filing", signalType: "awaiting" },
      ["Quarterly rebalance"],
    )).toBe("actionable");
  });
});

describe("normalizeSignalKey", () => {
  it("collapses case, punctuation and whitespace", () => {
    expect(normalizeSignalKey("Coffee Shop!")).toBe("coffee shop");
    expect(normalizeSignalKey("coffee  shop")).toBe("coffee shop");
    expect(normalizeSignalKey("coffee-shop")).toBe("coffee shop");
  });

  it("returns empty for punctuation-only titles", () => {
    expect(normalizeSignalKey("!!!")).toBe("");
  });
});

describe("isDuplicateSignal", () => {
  it("detects duplicates that exact-lowercase matching would miss", () => {
    const existing = ["Coffee Shop"];
    expect(isDuplicateSignal("coffee-shop!", existing)).toBe(true);
    expect(isDuplicateSignal("Tea House", existing)).toBe(false);
  });

  it("never treats an empty key as a duplicate", () => {
    expect(isDuplicateSignal("...", ["anything"])).toBe(false);
  });
});

describe("severity ordering", () => {
  it("sorts most urgent first", () => {
    const input: SignalSeverity[] = ["informational", "noise", "critical", "actionable"];
    const sorted = [...input].sort(bySeverity);
    expect(sorted).toEqual(["critical", "actionable", "informational", "noise"]);
  });

  it("has a strictly increasing order weight", () => {
    expect(SEVERITY_ORDER.critical).toBeLessThan(SEVERITY_ORDER.actionable);
    expect(SEVERITY_ORDER.actionable).toBeLessThan(SEVERITY_ORDER.informational);
    expect(SEVERITY_ORDER.informational).toBeLessThan(SEVERITY_ORDER.noise);
  });
});
