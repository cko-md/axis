import { describe, expect, it } from "vitest";
import { buildObjectivesScanContext, buildSignalsScanTaskContext } from "./platformScanContext";

describe("platform scan context builders", () => {
  it("removes control characters and bounds objective scan note bodies", () => {
    const context = buildObjectivesScanContext({
      tasks: [{ title: "  Finish\u0000Protocol ", priority: "hi", deadline: " tomorrow " }],
      notes: [{ title: "Long note", body: `${"x".repeat(260)}\n\nsecret tail` }],
      signals: [{ title: "Inbox item", signal_type: "action" }],
    });

    expect(context).toContain("- Finish Protocol [hi] due tomorrow");
    expect(context).toContain("NOTES:");
    expect(context).not.toContain("secret tail");
    expect(context).not.toContain("\u0000");
  });

  it("omits blank rows and caps total objective context", () => {
    const context = buildObjectivesScanContext({
      tasks: Array.from({ length: 100 }, (_, i) => ({ title: `Task ${i} ${"a".repeat(300)}`, priority: "med" })),
      notes: [{ title: "", body: "ignored" }],
      signals: [{ title: "   " }],
    });

    expect(context.length).toBeLessThanOrEqual(8_000);
    expect(context).toContain("TASKS:");
    expect(context).not.toContain("ignored");
  });

  it("bounds signal scan task context before model calls", () => {
    const context = buildSignalsScanTaskContext(
      Array.from({ length: 100 }, (_, i) => ({
        title: `Task ${i} ${"x".repeat(300)}`,
        priority: "critical",
        category: "research",
        status: "open",
        deadline: "next week",
      })),
    );

    expect(context.length).toBeLessThanOrEqual(8_000);
    expect(context).toContain("[CRITICAL]");
  });
});
