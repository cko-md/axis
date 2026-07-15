import { describe, expect, it } from "vitest";
import { buildApprovalRequest, isActionable, type ApprovalRequestInput } from "./approvalRequest";
import { approvalRequestToInsert, rowToApprovalRequest } from "./approvalPersistence";

function financialReq() {
  const input: ApprovalRequestInput = {
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
    taskId: "task-1",
  };
  return buildApprovalRequest(input);
}

describe("approvalPersistence round-trip", () => {
  it("insert promotes action-class columns and keeps the exact action in proposed_action", () => {
    const insert = approvalRequestToInsert(financialReq(), "user-1");
    expect(insert.user_id).toBe("user-1");
    expect(insert.action_class).toBe("FINANCIAL_EXECUTION");
    expect(insert.requirement).toBe("approval_step_up");
    expect(insert.task_id).toBe("task-1");
    expect(insert.expires_at).toBe("2026-07-13T17:05:00.000Z");
    expect(insert.proposed_action.tool).toBe("public.place_order");
    expect(insert.proposed_action.amount?.value).toBe(1899.5);
  });

  it("row -> request reproduces an actionable request (execute path)", () => {
    const insert = approvalRequestToInsert(financialReq(), "user-1");
    const req = rowToApprovalRequest({
      action_class: insert.action_class,
      requirement: insert.requirement,
      reasons: insert.reasons,
      proposed_action: insert.proposed_action as unknown as import("@/lib/supabase/database.types").Json,
      scope: insert.scope,
      expires_at: insert.expires_at,
      task_id: insert.task_id,
      step_up_verified_at: "2026-07-13T17:01:00.000Z",
    });
    expect(req.actionClass).toBe("FINANCIAL_EXECUTION");
    expect(req.stepUpRequired).toBe(true);
    const now = Date.parse("2026-07-13T17:02:00.000Z");
    expect(isActionable(req, { stepUpVerifiedAt: "2026-07-13T17:01:00.000Z", nowMs: now })).toBe(true);
    // Without step-up verification it must not be actionable.
    expect(isActionable(req, { stepUpVerifiedAt: null, nowMs: now })).toBe(false);
  });

  it("preserves scope downgrade (persistent never survives for execution)", () => {
    const input: ApprovalRequestInput = {
      actor: { kind: "user", id: "u" },
      tool: "public.place_order",
      summary: "Sell 5 MSFT",
      context: { actionClass: "FINANCIAL_EXECUTION" },
      target: { entityType: "order", accountId: "a" },
      amount: { value: 100, currency: "USD" },
      beforeState: {},
      afterState: {},
      dataFreshness: { tier: "fresh", retrievedAt: "2026-07-13T17:00:00.000Z" },
      expiresAt: "2026-07-13T17:05:00.000Z",
      scope: "persistent",
    };
    const insert = approvalRequestToInsert(buildApprovalRequest(input), "u");
    expect(insert.scope).toBe("one_time");
  });
});
