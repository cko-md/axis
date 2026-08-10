import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const mocks = vi.hoisted(() => ({
  decrypt: vi.fn(),
  getPlaidCreds: vi.fn(),
  getPolygonApiKey: vi.fn(),
  fetchSnapshot: vi.fn(),
}));

vi.mock("@/lib/crypto", () => ({ decrypt: mocks.decrypt }));
vi.mock("@/app/api/plaid/_lib", () => ({
  getPlaidCreds: mocks.getPlaidCreds,
  plaidHost: () => "https://plaid.invalid",
}));
vi.mock("@/lib/massive/client", () => ({
  getPolygonApiKey: mocks.getPolygonApiKey,
  fetchSnapshot: mocks.fetchSnapshot,
  fetchNews: vi.fn(),
  searchTickers: vi.fn(),
}));

import { executeTool, ToolOperationalError } from "./registry";

type QueryResult = { data: unknown[] | null; error: unknown };

function query(result: QueryResult) {
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq", "gte", "lte", "order", "limit", "range"]) {
    chain[method] = vi.fn(() => chain);
  }
  chain.then = (
    resolve: (value: QueryResult) => unknown,
    reject: (reason: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  return chain;
}

function client(results: QueryResult[]) {
  let read = 0;
  return {
    from: vi.fn(() => query(results[read++] ?? { data: [], error: null })),
  } as unknown as SupabaseClient;
}

const ctx = (supabase: SupabaseClient) => ({ supabase, userId: "user-1" });
const aapl = {
  symbol: "AAPL",
  shares: "2",
  cost_basis: "100",
  source: "plaid",
  currency: "USD",
  authority: "provider",
  provider: "plaid",
  provider_record_id: "holding-aapl",
  connection_id: "connection-1",
  retrieved_at: new Date().toISOString(),
  reconciliation_state: "matched",
  generation_id: "44444444-4444-4444-8444-444444444444",
};
const verifiedConnection = {
  id: "connection-1",
  provider: "plaid",
  status: "linked",
  authority: "provider_verified",
  verified_at: new Date().toISOString(),
};
const holdingCoverage = {
  connection_id: "connection-1",
  provider: "plaid",
  component: "holdings",
  complete: true,
  availability_status: "available",
  record_count: 1,
  retrieved_at: new Date().toISOString(),
  generation_id: "44444444-4444-4444-8444-444444444444",
  generation_hash: "a".repeat(64),
};

function plaidAccounts(accounts: unknown[]) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ accounts }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })));
}

describe("AI finance tool fault boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.decrypt.mockReturnValue("provider-token");
    mocks.getPlaidCreds.mockReturnValue({ clientId: "client", secret: "secret", env: "sandbox" });
    mocks.getPolygonApiKey.mockReturnValue("polygon-key");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns null live position metrics rather than cost basis when a quote is missing", async () => {
    mocks.fetchSnapshot.mockRejectedValue(new Error("quote unavailable"));

    const result = await executeTool(
      "get_position",
      { symbol: "AAPL" },
      ctx(client([
        { data: [aapl], error: null },
        { data: [aapl], error: null },
        { data: [verifiedConnection], error: null },
        { data: [holdingCoverage], error: null },
      ])),
    ) as Record<string, unknown>;

    expect(result).toMatchObject({
      shares: "2.000000",
      shares_micro: 2_000_000,
      cost_basis: "100.00",
      cost_basis_minor: 10_000,
      quote: null,
      live_available: false,
      live_reason: "QUOTE_UNAVAILABLE",
      position_value: null,
      unrealized_pl: null,
      weight: null,
    });
    expect(result.position_value).not.toBe(result.cost_basis);
  });

  it("does not serialize an unknown position as numeric zero", async () => {
    mocks.fetchSnapshot.mockRejectedValue(new Error("not found"));

    const result = await executeTool(
      "get_position",
      { symbol: "NVDA" },
      ctx(client([
        { data: [], error: null },
        { data: [], error: null },
      ])),
    );

    expect(result).toMatchObject({
      shares: null,
      cost_basis: null,
      live_available: false,
      live_reason: "POSITION_NOT_FOUND",
      position_value: null,
      unrealized_pl: null,
      weight: null,
    });
  });

  it("throws an observable safe operational error when portfolio data cannot load", async () => {
    const promise = executeTool(
      "get_position",
      { symbol: "AAPL" },
      ctx(client([
        { data: [aapl], error: null },
        { data: null, error: new Error("private database error") },
      ])),
    );

    await expect(promise).rejects.toEqual(expect.objectContaining({
      name: "ToolOperationalError",
      code: "DATA_QUERY_FAILED",
      message: "DATA_QUERY_FAILED",
    }));
    await expect(promise).rejects.toBeInstanceOf(ToolOperationalError);
  });

  it("fails closed without a server-only provider balance adapter", async () => {
    plaidAccounts([{
      name: "Checking",
      mask: "1234",
      type: "depository",
      balances: { current: 0, iso_currency_code: "USD" },
    }]);

    const result = await executeTool(
      "get_cash_accounts",
      {},
      ctx(client([])),
    );

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(result).toEqual({
      accounts: [],
      total_cash: null,
      available: false,
      reason: "CASH_PROVIDER_SERVER_ADAPTER_REQUIRED",
    });
  });

  it("verifies the full generation before applying spending filters", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const publishedStart = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
    const generationId = "11111111-1111-4111-8111-111111111111";
    const base = {
      custom_category: "FOOD",
      plaid_category: null,
      amount_minor: -1000,
      iso_currency_code: "USD",
      posted_date: today,
      is_transfer: false,
      excluded_from_budget: false,
      connection_id: "connection-1",
      retrieved_at: new Date().toISOString(),
      generation_id: generationId,
      authority: "provider",
    };
    const rows = [
      { ...base, amount: "-10.00" },
      { ...base, amount: "5.00", amount_minor: 500 },
      { ...base, amount: "-20.00", amount_minor: -2000, is_transfer: true },
      { ...base, amount: "-30.00", amount_minor: -3000, excluded_from_budget: true },
      { ...base, amount: "-40.00", amount_minor: -4000, posted_date: publishedStart },
    ];
    const supabase = {
      rpc: vi.fn(async () => ({
        data: [{
          available: true,
          coverage: [{
            connection_id: "connection-1",
            provider: "plaid",
            component: "transactions",
            complete: true,
            record_count: rows.length,
            retrieved_at: new Date().toISOString(),
            window_start: publishedStart,
            window_end: today,
            generation_id: generationId,
            generation_hash: "a".repeat(64),
          }],
          lineage_hash: "b".repeat(64),
        }],
        error: null,
      })),
      from: vi.fn(() => query({ data: rows, error: null })),
    } as unknown as SupabaseClient;

    const result = await executeTool(
      "get_spending_by_category",
      { range_days: 30 },
      ctx(supabase),
    );

    expect(result).toMatchObject({
      authority: "provider",
      by_category: [{
        category: "FOOD",
        total: "10.00",
        total_minor: 1000,
        currency: "USD",
      }],
    });
  });
});
