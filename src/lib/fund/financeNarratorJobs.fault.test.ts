import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const mocks = vi.hoisted(() => ({
  notifyViaMake: vi.fn(),
}));

vi.mock("@/lib/fund/notifyViaMake", () => ({
  notifyViaMake: mocks.notifyViaMake,
}));

import { checkBudgetThresholds, detectAndExplainAnomalies } from "./financeNarratorJobs";

function query(result: { data: unknown[]; error: null }) {
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq", "lt", "gte", "lte", "order", "range"]) {
    chain[method] = vi.fn(() => chain);
  }
  chain.then = (
    resolve: (value: typeof result) => unknown,
    reject: (reason: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  return chain;
}

function admin() {
  const generationId = "11111111-1111-4111-8111-111111111111";
  const today = new Date().toISOString().slice(0, 10);
  const publishedStart = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
  const baseTransaction = {
    custom_category: "FOOD",
    plaid_category: null,
    iso_currency_code: "USD",
    posted_date: today,
    is_transfer: false,
    excluded_from_budget: false,
    connection_id: "connection-1",
    generation_id: generationId,
    retrieved_at: new Date().toISOString(),
  };
  const transactionRows = [
    { ...baseTransaction, id: "debit", amount: "-90071992547409.91" },
    { ...baseTransaction, id: "credit", amount: "100.00" },
    { ...baseTransaction, id: "transfer", amount: "-100.00", is_transfer: true },
    { ...baseTransaction, id: "excluded", amount: "-100.00", excluded_from_budget: true },
    { ...baseTransaction, id: "older", amount: "-100.00", posted_date: publishedStart },
  ];
  return {
    rpc: vi.fn(async (_name: string, params: Record<string, unknown>) => ({
      data: [{
        available: true,
        coverage: [{
          connection_id: "connection-1",
          provider: "plaid",
          component: "transactions",
          complete: true,
          record_count: transactionRows.length,
          retrieved_at: new Date().toISOString(),
          window_start: publishedStart,
          window_end: params.p_window_end,
          generation_id: generationId,
          generation_hash: "a".repeat(64),
        }],
        lineage_hash: "b".repeat(64),
      }],
      error: null,
    })),
    from: vi.fn((table: string) => {
      if (table === "fund_category_budgets") {
        return query({ data: [{ category: "FOOD", monthly_limit: "0.01", currency: "USD" }], error: null });
      }
      if (table === "fund_bank_transactions") {
        return query({ data: transactionRows, error: null });
      }
      throw new Error(`Unexpected table ${table}`);
    }),
  } as unknown as SupabaseClient;
}

describe("finance narrator exact boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.notifyViaMake.mockResolvedValue({
      sent: false,
      accepted: true,
      status: 202,
      deliveryId: "delivery",
      deduped: false,
      auditRecorded: true,
      outboxRecorded: true,
      error: "DELIVERY_UNCONFIRMED",
    });
  });

  it("formats a near-MAX_SAFE budget ratio with a one-cent denominator without Number loss", async () => {
    await checkBudgetThresholds(admin(), "user-1", "person@example.com");

    expect(mocks.notifyViaMake).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        subject: "Budget alert: FOOD is at 900719925474099100%",
        meta: expect.objectContaining({
          spent: "90071992547409.91",
          spent_minor: Number.MAX_SAFE_INTEGER,
          limit: "0.01",
          limit_minor: 1,
        }),
      }),
    );
  });

  it("propagates an unavailable coverage verifier to the job failure boundary", async () => {
    const insightInsert = vi.fn();
    const provenanceAdmin = {
      from: vi.fn((table: string) => {
        if (table === "ai_insights") return { insert: insightInsert };
        throw new Error(`Unexpected table ${table}`);
      }),
    } as unknown as SupabaseClient;

    const outcome = detectAndExplainAnomalies(
      provenanceAdmin,
      "user-1",
      "person@example.com",
      null,
    );

    await expect(outcome).rejects.toThrow("TRANSACTION_COVERAGE_RPC_UNAVAILABLE");
    expect(mocks.notifyViaMake).not.toHaveBeenCalled();
    expect(insightInsert).not.toHaveBeenCalled();
  });
});
