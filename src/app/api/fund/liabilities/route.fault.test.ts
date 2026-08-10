import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));

import { GET, POST } from "./route";

const CONNECTION = "11111111-1111-4111-8111-111111111111";
const GENERATION = "22222222-2222-4222-8222-222222222222";
const NOW = new Date().toISOString();

function query(data: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "order", "limit"]) chain[method] = vi.fn(() => chain);
  chain.then = (resolve: (value: { data: unknown[]; error: null }) => unknown) =>
    Promise.resolve({ data, error: null }).then(resolve);
  return chain;
}

function client(options: { available?: boolean; generation?: string; count?: number } = {}) {
  const manual = {
    id: "manual", name: "Manual debt", kind: "other", balance: "50.00", currency: "USD",
    source: "manual", authority: "manual", retrieved_at: null,
  };
  const provider = {
    id: "provider", name: "Provider debt", kind: "credit_card", balance: "100.00", currency: "USD",
    source: "plaid", authority: "provider", provider: "plaid", provider_record_id: "account-1",
    connection_id: CONNECTION, generation_id: options.generation ?? GENERATION,
    retrieved_at: NOW, reconciliation_state: "matched",
  };
  return {
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: "user-1" } }, error: null })) },
    from: vi.fn((table: string) => {
      if (table === "fund_liabilities") return query([manual, provider]);
      if (table === "fund_connections") return query([{
        id: CONNECTION, provider: "plaid", status: "linked", authority: "provider_verified", verified_at: NOW,
      }]);
      if (table === "fund_provider_coverage") return query([{
        connection_id: CONNECTION, provider: "plaid", component: "liabilities",
        complete: true, record_count: options.count ?? 1, retrieved_at: NOW,
        availability_status: options.available === false ? "error" : "available",
        generation_id: GENERATION, generation_hash: "a".repeat(64),
      }]);
      throw new Error(`Unexpected table ${table}`);
    }),
  };
}

describe("liability provider-generation boundary", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    [{ available: false }, "LIABILITY_COVERAGE_UNAVAILABLE"],
    [{ generation: "33333333-3333-4333-8333-333333333333" }, "LIABILITY_COVERAGE_UNAVAILABLE"],
    [{ count: 2 }, "LIABILITY_COVERAGE_UNAVAILABLE"],
  ] as const)("withholds provider rows on coverage mismatch while preserving manual rows", async (options, reason) => {
    mocks.createClient.mockResolvedValue(client(options));

    const response = await GET(new NextRequest("http://axis.test/api/fund/liabilities"));
    const body = await response!.json();

    expect(body.providerUnavailableReason).toBe(reason);
    expect(body.liabilities).toEqual([expect.objectContaining({ id: "manual", authority: "manual" })]);
    expect(body.withheldProviderCount).toBe(1);
  });

  it("returns provider rows only when exact coverage and generation match", async () => {
    mocks.createClient.mockResolvedValue(client());

    const response = await GET(new NextRequest("http://axis.test/api/fund/liabilities"));
    const body = await response!.json();

    expect(body.providerUnavailable).toBe(false);
    expect(body.liabilities).toHaveLength(2);
  });

  it("rejects a stale opaque subject before creating a manual liability", async () => {
    const supabase = client();
    mocks.createClient.mockResolvedValue(supabase);

    const response = await POST(new NextRequest("http://axis.test/api/fund/liabilities", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-axis-expected-profile-subject": `ps1_${"f".repeat(64)}`,
      },
      body: JSON.stringify({ name: "Debt", kind: "other", balance: "1.00", currency: "USD" }),
    }));

    expect(response!.status).toBe(409);
    expect(await response!.json()).toEqual({ error: "SUBJECT_CHANGED" });
    expect(supabase.from).not.toHaveBeenCalled();
  });
});
