import { describe, expect, it } from "vitest";
import {
  buildApprovalRequest,
  isActionable,
  isApprovalExpired,
  isStepUpFresh,
  parseApprovalRequestInput,
  validateApprovalCompleteness,
  type ApprovalRequest,
  type ApprovalRequestInput,
} from "./approvalRequest";

const FIXED_NOW = Date.parse("2026-07-13T17:01:00.000Z");

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
    expect(validateApprovalCompleteness(req, FIXED_NOW)).toEqual({ complete: true, missing: [] });
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
    const { complete, missing } = validateApprovalCompleteness(req, FIXED_NOW);
    expect(complete).toBe(false);
    expect(missing).toEqual(
      expect.arrayContaining(["amount", "target.accountId", "beforeState", "afterState"]),
    );
  });

  it("rejects malformed financial values and non-object state from persisted rows", () => {
    const req = buildApprovalRequest(
      financialInput({
        actor: { kind: "routine", id: "rebalance", routineVersion: -1 },
        amount: { value: -1, currency: "usd", quantity: 0 },
        target: { entityType: "order", accountId: "   " },
        beforeState: null,
        afterState: [],
        dataFreshness: { tier: "unknown", retrievedAt: "2099-01-01T00:00:00.000Z" },
      }),
    );
    const { complete, missing } = validateApprovalCompleteness(req, FIXED_NOW);
    expect(complete).toBe(false);
    expect(missing).toEqual(expect.arrayContaining([
      "actor",
      "amount",
      "target.accountId",
      "beforeState",
      "afterState",
      "dataFreshness",
    ]));
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
  const now = FIXED_NOW;
  const freshStepUp = "2026-07-13T17:00:40.000Z"; // 20s before `now`

  it("is actionable when complete, unexpired, and step-up FRESH", () => {
    const req = buildApprovalRequest(financialInput());
    expect(isActionable(req, { stepUpVerifiedAt: freshStepUp, nowMs: now })).toBe(true);
  });

  it("is not actionable without step-up for a step-up class", () => {
    const req = buildApprovalRequest(financialInput());
    expect(isActionable(req, { stepUpVerifiedAt: null, nowMs: now })).toBe(false);
  });

  it("is not actionable when step-up is STALE (verified too long ago)", () => {
    const req = buildApprovalRequest(financialInput());
    // Verified 10 min before now, past the 5-min window.
    expect(isActionable(req, { stepUpVerifiedAt: "2026-07-13T16:51:00.000Z", nowMs: now })).toBe(false);
  });

  it("is not actionable when incomplete", () => {
    const req = buildApprovalRequest(financialInput({ amount: undefined }));
    expect(isActionable(req, { stepUpVerifiedAt: freshStepUp, nowMs: now })).toBe(false);
  });

  it("is not actionable when expired", () => {
    const req = buildApprovalRequest(financialInput());
    expect(
      isActionable(req, { stepUpVerifiedAt: "2026-07-13T17:59:50.000Z", nowMs: Date.parse("2026-07-13T18:00:00.000Z") }),
    ).toBe(false);
  });

  it("does not require step-up for a plain internal write", () => {
    const req = buildApprovalRequest(baseInput);
    expect(isActionable(req, { nowMs: now })).toBe(true);
  });
});

describe("parseApprovalRequestInput — untrusted boundary", () => {
  it("normalizes a valid request without trusting client-derived policy fields", () => {
    const result = parseApprovalRequestInput(
      {
        ...financialInput(),
        requirement: "approval",
        actor: { kind: "routine", id: "rebalance", routineVersion: 3 },
      },
      FIXED_NOW,
    );
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      value: expect.objectContaining({
        actor: { kind: "routine", id: "rebalance", routineVersion: 3 },
      }),
    }));
    if (result.ok) {
      expect(result.value).not.toHaveProperty("requirement");
    }
  });

  it.each([
    ["unknown actor kind", { actor: { kind: "system", id: "axis" } }],
    ["routine without a positive integer version", { actor: { kind: "routine", id: "axis", routineVersion: 0 } }],
    ["routine version on a non-routine actor", { actor: { kind: "agent", id: "axis", routineVersion: 1 } }],
    ["blank actor id", { actor: { kind: "agent", id: "   " } }],
    ["overlong tool", { tool: "x".repeat(257) }],
    ["overlong summary", { summary: "x".repeat(2_001) }],
    ["blank target", { target: { entityType: "   ", accountId: "acct-1" } }],
    ["non-boolean action flag", { context: { actionClass: "FINANCIAL_EXECUTION", touchesSensitiveData: "yes" } }],
    ["non-positive amount", { amount: { value: 0, currency: "USD", quantity: 1 } }],
    ["non-positive quantity", { amount: { value: 1, currency: "USD", quantity: 0 } }],
    ["non-ISO currency", { amount: { value: 1, currency: "usd", quantity: 1 } }],
    ["stale financial tier", { dataFreshness: { tier: "stale", retrievedAt: "2026-07-13T17:00:00.000Z" } }],
    ["future freshness timestamp", { dataFreshness: { tier: "fresh", retrievedAt: "2026-07-13T17:03:00.000Z" } }],
    ["too-old financial timestamp", { dataFreshness: { tier: "delayed", retrievedAt: "2026-07-13T16:45:00.000Z" } }],
    ["null financial before-state", { beforeState: null }],
    ["array financial after-state", { afterState: [] }],
    ["expired expiry", { expiresAt: "2026-07-13T17:00:00.000Z" }],
    ["expiry beyond 24 hours", { expiresAt: "2026-07-14T17:01:00.001Z" }],
  ])("rejects %s", (_label, patch) => {
    const input = financialInput();
    const result = parseApprovalRequestInput(
      {
        ...input,
        ...patch,
        context: "context" in patch ? patch.context : input.context,
      },
      FIXED_NOW,
    );
    expect(result).toEqual({ ok: false, code: "INVALID_BODY" });
  });

  it("rejects invalid calendar timestamps rather than allowing Date rollover", () => {
    const result = parseApprovalRequestInput(
      financialInput({
        dataFreshness: { tier: "fresh", retrievedAt: "2026-02-31T17:00:00.000Z" },
      }),
      FIXED_NOW,
    );
    expect(result).toEqual({ ok: false, code: "INVALID_BODY" });
  });
});

describe("isStepUpFresh", () => {
  const now = Date.parse("2026-07-13T17:05:00.000Z");
  it("accepts a recent verification and rejects an old one", () => {
    expect(isStepUpFresh("2026-07-13T17:02:00.000Z", undefined, now)).toBe(true); // 3m
    expect(isStepUpFresh("2026-07-13T16:58:00.000Z", undefined, now)).toBe(false); // 7m
  });
  it("rejects missing, unparseable, and future-dated timestamps", () => {
    expect(isStepUpFresh(null, undefined, now)).toBe(false);
    expect(isStepUpFresh("nope", undefined, now)).toBe(false);
    expect(isStepUpFresh("2026-07-13T17:10:00.000Z", undefined, now)).toBe(false); // future
  });
  it("honors a custom max age", () => {
    expect(isStepUpFresh("2026-07-13T16:58:00.000Z", 10 * 60_000, now)).toBe(true);
  });
});
