import { describe, expect, it } from "vitest";
import {
  actionClassLabel,
  actionClassTone,
  approvalStatusLabel,
  approvalToneColor,
  formatApprovalAmount,
} from "./approvalCardView";
import type { ActionClass } from "./actionPolicy";

describe("approvalCardView", () => {
  it("labels every action class", () => {
    const classes: ActionClass[] = [
      "READ", "DRAFT", "SIMULATE", "INTERNAL_WRITE",
      "EXTERNAL_COMMUNICATION", "FINANCIAL_EXECUTION", "DESTRUCTIVE_ADMIN",
    ];
    for (const c of classes) expect(actionClassLabel(c).length).toBeGreaterThan(0);
  });

  it("escalates tone for execution and destructive classes", () => {
    expect(actionClassTone("READ")).toBe("neutral");
    expect(actionClassTone("INTERNAL_WRITE")).toBe("caution");
    expect(actionClassTone("EXTERNAL_COMMUNICATION")).toBe("caution");
    expect(actionClassTone("FINANCIAL_EXECUTION")).toBe("negative");
    expect(actionClassTone("DESTRUCTIVE_ADMIN")).toBe("negative");
    expect(approvalToneColor(actionClassTone("FINANCIAL_EXECUTION"))).toBe("var(--down)");
  });

  it("formats amounts with currency and optional quantity", () => {
    expect(formatApprovalAmount({ value: 1899.5, currency: "USD", quantity: 10 })).toBe("$1,899.50 · 10 units");
    expect(formatApprovalAmount({ value: 50, currency: "USD" })).toBe("$50.00");
    expect(formatApprovalAmount(undefined)).toBeNull();
  });

  it("falls back gracefully on a malformed currency code", () => {
    // "US" is not a valid 3-letter ISO-4217 code, so Intl throws and we fall back.
    expect(formatApprovalAmount({ value: 12, currency: "US" })).toBe("12.00 US");
  });

  it("labels statuses", () => {
    expect(approvalStatusLabel("pending")).toBe("Pending");
    expect(approvalStatusLabel("executed")).toBe("Executed");
  });
});
