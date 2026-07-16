import { describe, expect, it } from "vitest";
import {
  aggregateHoldingRows,
  projectAccount,
  projectApproval,
  projectHoldingRows,
  projectTask,
  type AccountEntityRow,
  type ApprovalEntityRow,
  type HoldingEntityRow,
  type TaskEntityRow,
} from "./projections";

const UUIDS = {
  account: "11111111-1111-4111-8111-111111111111",
  approval: "22222222-2222-4222-8222-222222222222",
  task: "33333333-3333-4333-8333-333333333333",
} as const;

describe("safe entity projections", () => {
  it("projects only display-safe account metadata", () => {
    const providerRow = {
      id: UUIDS.account,
      provider: "plaid",
      institution: "Example Credit Union",
      mask: "1234",
      status: "linked",
      updated_at: "2026-07-16T12:00:00.000Z",
      item_id: "provider-item-secret",
      access_token_enc: "encrypted-access-token",
      refresh_token_enc: "encrypted-refresh-token",
    };

    const result = projectAccount(providerRow satisfies AccountEntityRow);
    const serialized = JSON.stringify(result);

    expect(result.title).toBe("Example Credit Union");
    expect(result.subtitle).toContain("•••• 1234");
    expect(serialized).not.toContain("provider-item-secret");
    expect(serialized).not.toContain("encrypted-access-token");
    expect(serialized).not.toContain("encrypted-refresh-token");
    expect(serialized).not.toContain("item_id");
  });

  it("does not expose an approval's proposed action or reasons", () => {
    const approvalRow = {
      id: UUIDS.approval,
      action_class: "FINANCIAL_EXECUTION",
      requirement: "approval_step_up",
      status: "pending",
      scope: "one_time",
      expires_at: "2026-07-16T13:00:00.000Z",
      created_at: "2026-07-16T12:00:00.000Z",
      proposed_action: { recipient: "private@example.com", amount: 25_000 },
      reasons: ["Contains private decision context"],
    };

    const result = projectApproval(approvalRow satisfies ApprovalEntityRow);
    const serialized = JSON.stringify(result);

    expect(result.title).toBe("Financial Execution approval");
    expect(result.status).toBe("pending");
    expect(serialized).not.toContain("private@example.com");
    expect(serialized).not.toContain("25000");
    expect(serialized).not.toContain("private decision context");
    expect(serialized).not.toContain("proposed_action");
  });

  it("does not expose a durable task's raw context", () => {
    const taskRow = {
      id: UUIDS.task,
      objective: "Review the allocation proposal",
      status: "waiting_for_approval",
      source_skill: "portfolio-review",
      updated_at: "2026-07-16T12:00:00.000Z",
      context: { accountNumber: "private-account-number" },
    };

    const serialized = JSON.stringify(projectTask(taskRow satisfies TaskEntityRow));
    expect(serialized).not.toContain("private-account-number");
    expect(serialized).not.toContain("context");
  });
});

describe("holding aggregation", () => {
  const baseRows: HoldingEntityRow[] = [
    {
      symbol: "aapl",
      name: "Apple Inc.",
      shares: 1.5,
      cost_basis: 100.1,
      source: "manual",
      currency: "usd",
      reconciliation_state: "matched",
      retrieved_at: "2026-07-15T09:00:00.000Z",
      updated_at: "2026-07-15T10:00:00.000Z",
    },
    {
      symbol: "AAPL",
      name: "Apple Inc.",
      shares: 2.25,
      cost_basis: 50.25,
      source: "plaid",
      currency: "USD",
      reconciliation_state: "matched",
      retrieved_at: "2026-07-14T09:00:00.000Z",
      updated_at: "2026-07-16T10:00:00.000Z",
    },
  ];

  it("normalizes symbols and aggregates provider rows with minor-unit money math", () => {
    const [aggregate] = aggregateHoldingRows(baseRows);

    expect(aggregate).toEqual({
      symbol: "AAPL",
      name: "Apple Inc.",
      shares: 3.75,
      costBasis: 150.35,
      currency: "USD",
      sources: ["manual", "plaid"],
      reconciliationState: "matched",
      retrievedAt: "2026-07-14T09:00:00.000Z",
      updatedAt: "2026-07-16T10:00:00.000Z",
      rowCount: 2,
    });

    const [entity] = projectHoldingRows(baseRows);
    expect(entity.ref).toEqual({ kind: "holding", id: "AAPL" });
    expect(entity.meta).toEqual(
      expect.arrayContaining([
        { label: "Shares", value: "3.75" },
        { label: "Cost basis", value: "$150.35" },
        { label: "Sources", value: "manual, plaid" },
      ]),
    );
  });

  it("never adds cost bases across currencies without an explicit FX conversion", () => {
    const [aggregate] = aggregateHoldingRows([
      baseRows[0],
      { ...baseRows[1], currency: "EUR", cost_basis: 60 },
    ]);
    const [entity] = projectHoldingRows([
      baseRows[0],
      { ...baseRows[1], currency: "EUR", cost_basis: 60 },
    ]);

    expect(aggregate.currency).toBeNull();
    expect(aggregate.costBasis).toBeNull();
    expect(entity.meta).toContainEqual({ label: "Cost basis", value: "Mixed currencies" });
  });
});
