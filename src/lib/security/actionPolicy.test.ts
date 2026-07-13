import { describe, expect, it } from "vitest";
import {
  BASE_REQUIREMENT,
  decideApproval,
  requiresApproval,
  type ActionClass,
} from "./actionPolicy";

describe("action policy — baselines", () => {
  it("lets reads/drafts/simulations run automatically", () => {
    for (const cls of ["READ", "DRAFT", "SIMULATE"] as ActionClass[]) {
      expect(decideApproval({ actionClass: cls }).requirement).toBe("auto");
    }
  });

  it("requires approval for internal writes and external communication", () => {
    expect(decideApproval({ actionClass: "INTERNAL_WRITE" }).requirement).toBe("approval");
    expect(decideApproval({ actionClass: "EXTERNAL_COMMUNICATION" }).requirement).toBe("approval");
  });

  it("requires step-up for financial execution and destructive admin", () => {
    expect(decideApproval({ actionClass: "FINANCIAL_EXECUTION" }).requirement).toBe("approval_step_up");
    expect(decideApproval({ actionClass: "DESTRUCTIVE_ADMIN" }).requirement).toBe("approval_step_up");
  });

  it("BASE_REQUIREMENT covers every action class", () => {
    const classes: ActionClass[] = [
      "READ",
      "DRAFT",
      "SIMULATE",
      "INTERNAL_WRITE",
      "EXTERNAL_COMMUNICATION",
      "FINANCIAL_EXECUTION",
      "DESTRUCTIVE_ADMIN",
    ];
    for (const cls of classes) expect(BASE_REQUIREMENT[cls]).toBeDefined();
  });
});

describe("action policy — combinatorial prompt-injection rule", () => {
  it("forces approval when sensitive data + untrusted content + outbound action combine", () => {
    const decision = decideApproval({
      actionClass: "EXTERNAL_COMMUNICATION",
      touchesSensitiveData: true,
      usesUntrustedExternalContent: true,
    });
    expect(decision.requirement).toBe("approval");
    expect(decision.reasons[0]).toMatch(/prompt-injection/i);
  });

  it("does not trigger for a read even with both risk flags", () => {
    expect(
      decideApproval({
        actionClass: "READ",
        touchesSensitiveData: true,
        usesUntrustedExternalContent: true,
      }).requirement,
    ).toBe("auto");
  });

  it("does not trigger when only one risk flag is present", () => {
    expect(
      requiresApproval({ actionClass: "EXTERNAL_COMMUNICATION", touchesSensitiveData: true }),
    ).toBe(true); // still approval by baseline, but...
    const onlyOne = decideApproval({ actionClass: "EXTERNAL_COMMUNICATION", touchesSensitiveData: true });
    expect(onlyOne.reasons[0]).not.toMatch(/prompt-injection/i);
  });
});

describe("action policy — explicit trust downgrade", () => {
  it("can downgrade an internal write to auto when explicitly trusted", () => {
    expect(
      decideApproval({ actionClass: "INTERNAL_WRITE", explicitlyTrusted: true }).requirement,
    ).toBe("auto");
  });

  it("never downgrades financial execution or destructive admin", () => {
    expect(
      decideApproval({ actionClass: "FINANCIAL_EXECUTION", explicitlyTrusted: true }).requirement,
    ).toBe("approval_step_up");
    expect(
      decideApproval({ actionClass: "DESTRUCTIVE_ADMIN", explicitlyTrusted: true }).requirement,
    ).toBe("approval_step_up");
  });

  it("never downgrades an action caught by the combinatorial rule", () => {
    expect(
      decideApproval({
        actionClass: "EXTERNAL_COMMUNICATION",
        touchesSensitiveData: true,
        usesUntrustedExternalContent: true,
        explicitlyTrusted: true,
      }).requirement,
    ).toBe("approval");
  });
});
