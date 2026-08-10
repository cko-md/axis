import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const mocks = vi.hoisted(() => ({
  getPlaidCreds: vi.fn(),
  timedProviderFetch: vi.fn(),
}));

vi.mock("@/app/api/plaid/_lib", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/api/plaid/_lib")>();
  return {
    ...actual,
    getPlaidCreds: mocks.getPlaidCreds,
    plaidHost: () => "https://plaid.invalid",
  };
});
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

function adminClient(rpcError: unknown = null) {
  const rpcCalls: Array<{ name: string; params: Record<string, unknown> }> = [];
  const from = vi.fn((_table: string) => {
    const selectChain: Record<string, unknown> = {};
    for (const method of ["select", "eq", "gte"]) {
      selectChain[method] = vi.fn(() => selectChain);
    }
    selectChain.then = (
      resolve: (value: { data: unknown[]; error: null }) => unknown,
      reject: (reason: unknown) => unknown,
    ) => Promise.resolve({ data: [], error: null })
      .then(resolve, reject);

    return {
      ...selectChain,
    };
  });
  const rpc = vi.fn(async (name: string, params: Record<string, unknown>) => {
    rpcCalls.push({ name, params });
    const rows = Array.isArray(params.p_rows) ? params.p_rows : [];
    return {
      data: [{ record_count: rows.length, generation_hash: "a".repeat(64) }],
      error: rpcError,
    };
  });

  return {
    admin: { from, rpc } as unknown as SupabaseClient,
    from,
    rpcCalls,
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
    mocks.timedProviderFetch.mockImplementation(async () =>
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

    const rows = db.rpcCalls[0]?.params.p_rows as Array<Record<string, unknown>>;
    expect(rows[0]?.retrieved_at).toBe(providerCompletedAt);
  });

  it("does not fabricate USD when the provider omits transaction currency", async () => {
    const db = adminClient();
    mocks.timedProviderFetch.mockImplementation(async () =>
      plaidResponse([plaidTransaction({ iso_currency_code: null })]),
    );

    const result = await syncPlaidTransactions(
      db.admin,
      "user-1",
      "connection-1",
      "token",
    );

    expect(result).toEqual({ error: "PLAID_TRANSACTION_CURRENCY_UNAVAILABLE" });
    expect(db.rpcCalls).toHaveLength(0);
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
    const firstPage = Array.from({ length: 500 }, (_, index) =>
      plaidTransaction({ transaction_id: `transaction-${index}` }),
    );
    mocks.timedProviderFetch
      .mockResolvedValueOnce(plaidResponse(firstPage, 501))
      .mockResolvedValueOnce(plaidResponse([], 501));

    await syncPlaidTransactions(db.admin, "user-1", "connection-1", "token");

    expect(mocks.timedProviderFetch).toHaveBeenCalledTimes(2);
    const secondInit = mocks.timedProviderFetch.mock.calls[1]?.[1] as { body: string };
    expect(JSON.parse(secondInit.body)).toMatchObject({
      options: { count: 500, offset: 500 },
    });
  });

  it("rejects a stable-count delete/insert mutation between complete offset generations", async () => {
    const db = adminClient();
    mocks.timedProviderFetch
      .mockResolvedValueOnce(plaidResponse([plaidTransaction({ transaction_id: "old" })]))
      .mockResolvedValueOnce(plaidResponse([plaidTransaction({ transaction_id: "replacement" })]));

    const result = await syncPlaidTransactions(db.admin, "user-1", "connection-1", "token");

    expect(result).toEqual({ error: "PLAID_TXN_GENERATION_CHANGED" });
    expect(db.rpcCalls).toHaveLength(0);
  });

  it("rejects an oversized declared provider page before publication", async () => {
    const db = adminClient();
    const response = plaidResponse([plaidTransaction()]);
    response.headers.set("content-length", String(4 * 1024 * 1024 + 1));
    mocks.timedProviderFetch.mockResolvedValueOnce(response);

    const result = await syncPlaidTransactions(db.admin, "user-1", "connection-1", "token");

    expect(result).toEqual({ error: "PLAID_INVALID_RESPONSE" });
    expect(db.rpcCalls).toHaveLength(0);
  });

  it("rejects a chunked provider page that crosses the decompressed byte cap", async () => {
    const db = adminClient();
    const oversized = new Uint8Array(4 * 1024 * 1024 + 1).fill(32);
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(oversized);
        controller.close();
      },
      cancel,
    }), { status: 200 });
    mocks.timedProviderFetch.mockResolvedValueOnce(response);

    const result = await syncPlaidTransactions(db.admin, "user-1", "connection-1", "token");

    expect(result).toEqual({ error: "PLAID_INVALID_RESPONSE" });
    expect(db.rpcCalls).toHaveLength(0);
  });

  it("publishes the complete generation through the atomic database contract", async () => {
    const db = adminClient();

    await syncPlaidTransactions(db.admin, "user-1", "connection-1", "token");

    expect(db.rpcCalls).toEqual([expect.objectContaining({
      name: "publish_fund_transaction_generation",
      params: expect.objectContaining({
        p_user_id: "user-1",
        p_connection_id: "connection-1",
        p_rows: [expect.objectContaining({
          plaid_transaction_id: "transaction-1",
          generation_id: expect.any(String),
        })],
      }),
    })]);
    expect(db.from).not.toHaveBeenCalled();
  });

  it("fails closed when the atomic publication contract is unavailable", async () => {
    const db = adminClient();
    const withoutRpc = { from: db.from } as unknown as SupabaseClient;

    const result = await syncPlaidTransactions(withoutRpc, "user-1", "connection-1", "token");

    expect(result).toEqual({ error: "PLAID_TRANSACTION_ATOMIC_PUBLISH_UNAVAILABLE" });
    expect(db.from).not.toHaveBeenCalled();
  });

  it("does not report success when atomic publication fails", async () => {
    const db = adminClient({ message: "transaction rolled back" });

    const result = await syncPlaidTransactions(db.admin, "user-1", "connection-1", "token");

    expect(result).toEqual({ error: "PLAID_TRANSACTION_PERSIST_FAILED" });
  });

  it("does not report success without an exact publication receipt", async () => {
    const db = adminClient();
    (db.admin.rpc as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: [{ record_count: 0, generation_hash: "invalid" }],
      error: null,
    });

    const result = await syncPlaidTransactions(db.admin, "user-1", "connection-1", "token");

    expect(result).toEqual({ error: "PLAID_TRANSACTION_PERSIST_FAILED" });
  });

  it("does not publish when cancellation lands after the last provider body", async () => {
    const controller = new AbortController();
    const db = adminClient();
    const encoded = new TextEncoder().encode(JSON.stringify({
      transactions: [plaidTransaction()],
      total_transactions: 1,
    }));
    mocks.timedProviderFetch.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({
      pull(stream) {
        stream.enqueue(encoded);
        controller.abort();
        stream.close();
      },
    }), { status: 200 }));

    const result = await syncPlaidTransactions(
      db.admin,
      "user-1",
      "connection-1",
      "token",
      controller.signal,
    );

    expect(result).toEqual({ error: "PLAID_TXN_DEADLINE_EXCEEDED" });
    expect(db.rpcCalls).toHaveLength(0);
  });

  it("classifies a provider rejection after parent cancellation as deadline exhaustion", async () => {
    const controller = new AbortController();
    const db = adminClient();
    mocks.timedProviderFetch.mockImplementation(async () => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    });

    const result = await syncPlaidTransactions(
      db.admin,
      "user-1",
      "connection-1",
      "token",
      controller.signal,
    );

    expect(result).toEqual({ error: "PLAID_TXN_DEADLINE_EXCEEDED" });
    expect(db.rpcCalls).toHaveLength(0);
  });
});
