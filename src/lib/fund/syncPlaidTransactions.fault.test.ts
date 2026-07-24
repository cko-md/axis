import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const mocks = vi.hoisted(() => ({
  getPlaidCreds: vi.fn(),
  timedProviderFetch: vi.fn(),
}));

vi.mock("@/app/api/plaid/_lib", () => ({
  getPlaidCreds: mocks.getPlaidCreds,
  plaidHost: () => "https://plaid.invalid",
}));
vi.mock("@/lib/observability/providerTiming", () => ({
  timedProviderFetch: mocks.timedProviderFetch,
}));

import { syncPlaidTransactions } from "./syncPlaidTransactions";

const NOW = "2026-07-23T12:00:00.000Z";

function plaidTransaction(overrides: Record<string, unknown> = {}) {
  return {
    transaction_id: "transaction-1",
    account_id: "account-1",
    name: "Merchant",
    merchant_name: "Merchant",
    amount: 10,
    date: "2026-07-22",
    pending: false,
    iso_currency_code: "USD",
    ...overrides,
  };
}

function plaidResponse(
  transactions: unknown[],
  totalTransactions = transactions.length,
) {
  return new Response(JSON.stringify({
    transactions,
    total_transactions: totalTransactions,
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function adminClient(transferRows: unknown[] = []) {
  const transactionUpserts: unknown[] = [];
  const coverageUpserts: unknown[] = [];
  const transferUpdates: unknown[] = [];
  const from = vi.fn((table: string) => {
    const selectChain: Record<string, unknown> = {};
    for (const method of ["select", "eq", "gte"]) {
      selectChain[method] = vi.fn(() => selectChain);
    }
    selectChain.then = (
      resolve: (value: { data: unknown[]; error: null }) => unknown,
      reject: (reason: unknown) => unknown,
    ) => Promise.resolve({ data: table === "fund_bank_transactions" ? transferRows : [], error: null })
      .then(resolve, reject);

    return {
      ...selectChain,
      upsert: vi.fn(async (payload: unknown) => {
        if (table === "fund_bank_transactions") transactionUpserts.push(payload);
        if (table === "fund_provider_coverage") coverageUpserts.push(payload);
        return { error: null };
      }),
      update: vi.fn((payload: unknown) => ({
        in: vi.fn(async () => {
          if (table === "fund_bank_transactions") transferUpdates.push(payload);
          return { error: null };
        }),
      })),
    };
  });

  return {
    admin: { from } as unknown as SupabaseClient,
    transactionUpserts,
    coverageUpserts,
    transferUpdates,
  };
}

describe("Plaid transaction ingestion financial-truth faults", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    vi.clearAllMocks();
    mocks.getPlaidCreds.mockReturnValue({
      clientId: "client",
      secret: "secret",
      env: "sandbox",
    });
    mocks.timedProviderFetch.mockResolvedValue(
      plaidResponse([plaidTransaction()]),
    );
  });

  it("anchors retrieved_at after the provider body has completed", async () => {
    const db = adminClient();
    const providerCompletedAt = "2026-07-23T12:00:05.000Z";
    mocks.timedProviderFetch.mockImplementation(async () => {
      vi.setSystemTime(new Date(providerCompletedAt));
      return plaidResponse([plaidTransaction()]);
    });

    await syncPlaidTransactions(db.admin, "user-1", "connection-1", "token");

    const rows = db.transactionUpserts[0] as Array<Record<string, unknown>>;
    expect(rows[0]?.retrieved_at).toBe(providerCompletedAt);
  });

  it("does not fabricate USD when the provider omits transaction currency", async () => {
    const db = adminClient();
    mocks.timedProviderFetch.mockResolvedValue(
      plaidResponse([plaidTransaction({ iso_currency_code: null })]),
    );

    const result = await syncPlaidTransactions(
      db.admin,
      "user-1",
      "connection-1",
      "token",
    );

    expect(result).toEqual({ error: "PLAID_TRANSACTION_CURRENCY_UNAVAILABLE" });
    expect(db.transactionUpserts).toHaveLength(0);
  });

  it("requests the 90-day anomaly window rather than a 30-day subset", async () => {
    const db = adminClient();

    await syncPlaidTransactions(db.admin, "user-1", "connection-1", "token");

    const init = mocks.timedProviderFetch.mock.calls[0]?.[1] as { body: string };
    const requestBody = JSON.parse(init.body) as { start_date: string; end_date: string };
    const requestedDays = (
      Date.parse(requestBody.end_date) - Date.parse(requestBody.start_date)
    ) / 86_400_000;
    expect(requestedDays).toBeGreaterThanOrEqual(90);
  });

  it("does not claim success until every reported provider page is consumed", async () => {
    const db = adminClient();
    mocks.timedProviderFetch
      .mockResolvedValueOnce(plaidResponse([plaidTransaction()], 251))
      .mockResolvedValueOnce(plaidResponse([], 251));

    await syncPlaidTransactions(db.admin, "user-1", "connection-1", "token");

    expect(mocks.timedProviderFetch).toHaveBeenCalledTimes(2);
    const secondInit = mocks.timedProviderFetch.mock.calls[1]?.[1] as { body: string };
    expect(JSON.parse(secondInit.body)).toMatchObject({
      options: { count: 250, offset: 250 },
    });
  });

  it("writes a connection-scoped transaction coverage fact after a complete sync", async () => {
    const db = adminClient();

    await syncPlaidTransactions(db.admin, "user-1", "connection-1", "token");

    expect(db.coverageUpserts).toEqual([expect.objectContaining({
      user_id: "user-1",
      connection_id: "connection-1",
      provider: "plaid",
      component: "transactions",
      complete: true,
      record_count: 1,
    })]);
  });

  it("does not tag equal-magnitude transactions across different currencies", async () => {
    const db = adminClient([
      {
        id: "usd",
        account_id: "account-1",
        amount: "-100.00",
        iso_currency_code: "USD",
        connection_id: "connection-1",
        posted_date: "2026-07-22",
        is_transfer: false,
      },
      {
        id: "eur",
        account_id: "account-2",
        amount: "100.00",
        iso_currency_code: "EUR",
        connection_id: "connection-2",
        posted_date: "2026-07-22",
        is_transfer: false,
      },
    ]);

    await syncPlaidTransactions(db.admin, "user-1", "connection-1", "token");

    expect(db.transferUpdates).toHaveLength(0);
  });
});
