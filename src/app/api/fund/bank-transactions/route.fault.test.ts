import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  redactRouteError: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/observability/redactRouteError", () => ({
  redactRouteError: mocks.redactRouteError,
}));

import { NextRequest } from "next/server";
import { GET } from "./route";

const CURRENT_GENERATION = "11111111-1111-4111-8111-111111111111";
const OLD_GENERATION = "22222222-2222-4222-8222-222222222222";

function supabaseClient() {
  const today = new Date().toISOString().slice(0, 10);
  const windowStart = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
  const currentRows = [
    {
      id: "current-visible",
      user_id: "user-1",
      provider: "plaid",
      authority: "provider",
      connection_id: "connection-1",
      generation_id: CURRENT_GENERATION,
      posted_date: today,
      merchant_name: "Current visible",
      custom_category: "FOOD",
      account_id: "account-1",
      reviewed: false,
      is_transfer: false,
    },
    {
      id: "current-transfer",
      user_id: "user-1",
      provider: "plaid",
      authority: "provider",
      connection_id: "connection-1",
      generation_id: CURRENT_GENERATION,
      posted_date: today,
      merchant_name: "Current transfer",
      custom_category: "TRANSFER",
      account_id: "account-1",
      reviewed: false,
      is_transfer: true,
    },
  ];
  const unprovenRows = [
    {
      ...currentRows[0],
      id: "legacy-row",
      authority: "legacy_unknown",
      connection_id: "legacy-connection",
      generation_id: OLD_GENERATION,
      merchant_name: "Legacy",
    },
    {
      ...currentRows[0],
      id: "stale-provider-row",
      generation_id: OLD_GENERATION,
      merchant_name: "Stale provider",
    },
  ];
  const from = vi.fn(() => {
    const filters = new Map<string, unknown>();
    let range: [number, number] = [0, 499];
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn((key: string, value: unknown) => {
      filters.set(key, value);
      return chain;
    });
    for (const method of ["gte", "lte", "order", "ilike"]) chain[method] = vi.fn(() => chain);
    chain.range = vi.fn((start: number, end: number) => {
      range = [start, end];
      return chain;
    });
    chain.then = (
      resolve: (value: { data: unknown[]; error: null; count?: number }) => unknown,
      reject: (reason: unknown) => unknown,
    ) => {
      const exact = filters.get("provider") === "plaid"
        && filters.get("authority") === "provider"
        && filters.get("connection_id") === "connection-1"
        && filters.get("generation_id") === CURRENT_GENERATION;
      const source = exact ? currentRows : [...unprovenRows, ...currentRows];
      const data = source.slice(range[0], range[1] + 1);
      return Promise.resolve({ data, error: null, count: source.length }).then(resolve, reject);
    };
    return chain;
  });
  return {
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: "user-1" } }, error: null })) },
    rpc: vi.fn(async (): Promise<{ data: unknown; error: unknown }> => ({
      data: [{
        available: true,
        coverage: [{
          connection_id: "connection-1",
          provider: "plaid",
          component: "transactions",
          complete: true,
          record_count: currentRows.length,
          retrieved_at: new Date().toISOString(),
          window_start: windowStart,
          window_end: today,
          generation_id: CURRENT_GENERATION,
          generation_hash: "a".repeat(64),
        }],
        lineage_hash: "b".repeat(64),
      }],
      error: null,
    })),
    from,
  };
}

describe("fund bank-transactions authority boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.redactRouteError.mockImplementation(() => new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    ));
  });

  it("paginates and totals only proof-bound current-generation rows", async () => {
    const client = supabaseClient();
    mocks.createClient.mockResolvedValue(client);

    const response = await GET(new NextRequest("https://axis.example/api/fund/bank-transactions"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      completeness: "complete_source_page",
      verifiedEmpty: false,
      transactions: [{ id: "current-visible" }],
      page: { offset: 0, limit: 100, total: 1, hasMore: false },
    });
    expect(body.transactions.map((row: { id: string }) => row.id)).not.toContain("legacy-row");
    expect(body.transactions.map((row: { id: string }) => row.id)).not.toContain("stale-provider-row");
  });

  it("captures an operational coverage failure and returns non-2xx", async () => {
    const client = supabaseClient();
    client.rpc.mockResolvedValueOnce({ data: null, error: new Error("private database outage") });
    mocks.createClient.mockResolvedValue(client);

    const response = await GET(new NextRequest("https://axis.example/api/fund/bank-transactions"));

    expect(response.status).toBe(500);
    expect(mocks.redactRouteError).toHaveBeenCalledWith(
      expect.any(Error),
      { route: "fund/bank-transactions", area: "fund" },
    );
  });
});
