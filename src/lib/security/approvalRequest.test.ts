import { describe, expect, it } from "vitest";
import {
  buildApprovalRequest,
  isActionable,
  isApprovalExpired,
  validateApprovalCompleteness,
  type ApprovalRequest,
  type ApprovalRequestInput,
} from "./approvalRequest";

const baseInput: ApprovalRequestInput = {
  actor: { kind: "agent", id: "agent-1" },
  tool: "internal.update_tag",
  summary: "Tag transaction #123 as 'reviewed'",
  context: { actionClass: "INTERNAL_WRITE" },
  target: { entityType: "transaction", entityId: "123" },
};

function financialInput(overrides: Partial<ApprovalRequestInput> = {}): ApprovalRequestInput {
  return {
    actor: { kind: "routine", id: "rebalance", routineVersion: 3 },
    tool: "public.place_order",
    summary: "Buy 10 AAPL at market",
    context: { actionClass: "FINANCIAL_EXECUTION", touchesSensitiveData: true },
    target: { entityType: "order", accountId: "acct-1" },
    amount: { value: 1899.5, currency: "USD", quantity: 10 },
    beforeState: { position: 0 },
    afterState: { position: 10 },
    dataFreshness: { tier: "fresh", retrievedAt: "2026-07-13T17:00:00.000Z" },
    expiresAt: "2026-07-13T17:05:00.000Z",
    ...overrides,
  };
}

describe("buildApprovalRequest — derives from the policy kernel", () => {
  it("copies the decideApproval requirement, reasons, and step-up flag", () => {
    const req = buildApprovalRequest(financialInput());
    expect(req.requirement).toBe("approval_step_up");
    expect(req.stepUpRequired).toBe(true);
    expect(req.actionClass).toBe("FINANCIAL_EXECUTION");
    expect(req.reasons.length).toBeGreaterThan(0);
  });

  it("marks internal writes as approval, not step-up", () => {
    const req = buildApprovalRequest(baseInput);
    expect(req.requirement).toBe("approval");
    expect(req.stepUpRequired).toBe(false);
  });

  it("defaults scope to one_time", () => {
    expect(buildApprovalRequest(baseInput).scope).toBe("one_time");
  });

  it("allows persistent scope for internal writes", () => {
    const req = buildApprovalRequest({ ...baseInput, scope: "persistent" });
    expect(req.scope).toBe("persistent");
  });

  it("never allows persistent scope for financial execution or destructive admin", () => {
    expect(buildApprovalRequest(financialInput({ scope: "persistent" })).scope).toBe("one_time");
    const destructive = buildApprovalRequest({
      ...baseInput,
      context: { actionClass: "DESTRUCTIVE_ADMIN" },
      scope: "persistent",
      beforeState: { existed: true },
    });
    expect(destructive.scope).toBe("one_time");
  });
});

describe("validateApprovalCompleteness — never a bare Allow", () => {
  it("accepts a fully-populated financial execution approval", () => {
    const req = buildApprovalRequest(financialInput());
    expect(validateApprovalCompleteness(req)).toEqual({ complete: true, missing: [] });
  });

  it("flags a financial execution missing amount, account, and states", () => {
    const req = buildApprovalRequest(
      financialInput({
        amount: undefined,
        target: { entityType: "order" },
        beforeState: undefined,
        afterState: undefined,
      }),
    );
    const { complete, missing } = validateApprovalCompleteness(req);
    expect(complete).toBe(false);
    expect(missing).toEqual(
      expect.arrayContaining(["amount", "target.accountId", "beforeState", "afterState"]),
    );
  });

  it("requires freshness + expiry for outbound/executing actions", () => {
    const req = buildApprovalRequest({
      actor: { kind: "agent", id: "a" },
      tool: "gmail.send",
      summary: "Send portfolio summary to advisor",
      context: { actionClass: "EXTERNAL_COMMUNICATION" },
      target: { entityType: "email", entityId: "draft-1" },
    });
    const { missing } = validateApprovalCompleteness(req);
    expect(missing).toEqual(expect.arrayContaining(["dataFreshness", "expiresAt"]));
  });

  it("does not demand freshness/expiry for a plain internal write", () => {
    const req = buildApprovalRequest(baseInput);
    const { missing } = validateApprovalCompleteness(req);
    expect(missing).not.toContain("dataFreshness");
    expect(missing).not.toContain("expiresAt");
  });

  it("flags core fields (actor, tool, summary, target) when absent", () => {
    const req = buildApprovalRequest({
      actor: { kind: "user", id: "" },
      tool: "",
      summary: "   ",
      context: { actionClass: "INTERNAL_WRITE" },
      target: { entityType: "" },
    });
    const { missing } = validateApprovalCompleteness(req);
    expect(missing).toEqual(expect.arrayContaining(["actor", "tool", "summary", "target"]));
  });

  it("requires before-state for destructive admin", () => {
    const req = buildApprovalRequest({
      actor: { kind: "user", id: "u" },
      tool: "integrations.revoke",
      summary: "Revoke Plaid connection",
      context: { actionClass: "DESTRUCTIVE_ADMIN" },
      target: { entityType: "integration", entityId: "plaid" },
      dataFreshness: { tier: "fresh", retrievedAt: "2026-07-13T17:00:00.000Z" },
      expiresAt: "2026-07-13T17:05:00.000Z",
    });
    expect(validateApprovalCompleteness(req).missing).toContain("beforeState");
  });
});

describe("isApprovalExpired — fail safe, never fail open", () => {
  const req = buildApprovalRequest(financialInput());

  it("is not expired before the expiry", () => {
    expect(isApprovalExpired(req, Date.parse("2026-07-13T17:04:59.000Z"))).toBe(false);
  });

  it("is expired at or after the expiry", () => {
    expect(isApprovalExpired(req, Date.parse("2026-07-13T17:05:00.000Z"))).toBe(true);
    expect(isApprovalExpired(req, Date.parse("2026-07-13T18:00:00.000Z"))).toBe(true);
  });

  it("never expires when no expiry is set", () => {
    const noExpiry = buildApprovalRequest(baseInput);
    expect(isApprovalExpired(noExpiry, Date.now())).toBe(false);
  });

  it("treats an unparseable expiry as expired", () => {
    const bad = { ...req, expiresAt: "not-a-date" } as ApprovalRequest;
    expect(isApprovalExpired(bad, Date.now())).toBe(true);
  });
});

describe("isActionable — the single execution gate", () => {
  const now = Date.parse("2026-07-13T17:01:00.000Z");

  it("is actionable when complete, unexpired, and step-up verified", () => {
    const req = buildApprovalRequest(financialInput());
    expect(isActionable(req, { stepUpVerified: true, nowMs: now })).toBe(true);
  });

  it("is not actionable without step-up for a step-up class", () => {
    const req = buildApprovalRequest(financialInput());
    expect(isActionable(req, { stepUpVerified: false, nowMs: now })).toBe(false);
  });

  it("is not actionable when incomplete", () => {
    const req = buildApprovalRequest(financialInput({ amount: undefined }));
    expect(isActionable(req, { stepUpVerified: true, nowMs: now })).toBe(false);
  });

  it("is not actionable when expired", () => {
    const req = buildApprovalRequest(financialInput());
    expect(
      isActionable(req, { stepUpVerified: true, nowMs: Date.parse("2026-07-13T18:00:00.000Z") }),
    ).toBe(false);
  });

  it("does not require step-up for a plain internal write", () => {
    const req = buildApprovalRequest(baseInput);
    expect(isActionable(req, { nowMs: now })).toBe(true);
  });
});
