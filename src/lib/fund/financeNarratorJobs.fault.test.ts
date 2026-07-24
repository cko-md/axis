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
  for (const method of ["select", "eq", "lt", "gte"]) chain[method] = vi.fn(() => chain);
  chain.then = (
    resolve: (value: typeof result) => unknown,
    reject: (reason: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  return chain;
}

function admin() {
  return {
    from: vi.fn((table: string) => {
      if (table === "fund_category_budgets") {
        return query({ data: [{ category: "FOOD", monthly_limit: "0.01", currency: "USD" }], error: null });
      }
      if (table === "fund_bank_transactions") {
        return query({
          data: [{
            custom_category: "FOOD",
            plaid_category: null,
            amount: "-90071992547409.91",
            iso_currency_code: "USD",
            connection_id: "connection-1",
            retrieved_at: "2026-07-23T12:00:00.000Z",
          }],
          error: null,
        });
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

  it("does not notify or persist an anomaly when current/history provenance is missing", async () => {
    const today = new Date().toISOString().slice(0, 10);
    let transactionRead = 0;
    const insightInsert = vi.fn();
    const provenanceAdmin = {
      from: vi.fn((table: string) => {
        if (table === "fund_bank_transactions") {
          const data = transactionRead++ === 0
            ? [{
                id: "prior",
                merchant_name: "Merchant",
                amount: "-10.00",
                iso_currency_code: "USD",
                posted_date: "2026-07-01",
                is_transfer: false,
                pending: false,
                connection_id: null,
                retrieved_at: null,
              }]
            : [{
                id: "today",
                merchant_name: "Merchant",
                amount: "-500.00",
                iso_currency_code: "USD",
                posted_date: today,
                is_transfer: false,
                pending: false,
                connection_id: null,
                retrieved_at: null,
              }];
          return query({ data, error: null });
        }
        if (table === "ai_insights") return { insert: insightInsert };
        throw new Error(`Unexpected table ${table}`);
      }),
    } as unknown as SupabaseClient;

    const outcome = await detectAndExplainAnomalies(
      provenanceAdmin,
      "user-1",
      "person@example.com",
      null,
    );

    expect(outcome).toEqual({ attempted: 0, failed: 0, results: [] });
    expect(mocks.notifyViaMake).not.toHaveBeenCalled();
    expect(insightInsert).not.toHaveBeenCalled();
  });
});
