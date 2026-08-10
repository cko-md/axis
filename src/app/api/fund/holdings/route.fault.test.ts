import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: mocks.createClient,
}));

import { GET } from "./route";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const GENERATION_ID = "22222222-2222-4222-8222-222222222222";

function query(data: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq", "order", "limit"]) chain[method] = vi.fn(() => chain);
  chain.then = (
    resolve: (value: { data: unknown[]; error: null }) => unknown,
    reject: (reason: unknown) => unknown,
  ) => Promise.resolve({ data, error: null }).then(resolve, reject);
  return chain;
}

function client(options: {
  coverageAvailable?: boolean;
  includeManual?: boolean;
  manualOnly?: boolean;
  rogueProvider?: boolean;
  connectionCount?: number;
} = {}) {
  const update = vi.fn();
  const retrievedAt = new Date().toISOString();
  const providerHolding = {
      id: "holding-1",
      symbol: "AAPL",
      name: "Apple",
      shares: "1",
      cost_basis: "10.00",
      source: "plaid",
      authority: "provider",
      currency: "USD",
      reconciliation_state: "matched",
      retrieved_at: retrievedAt,
      provider: "plaid",
      provider_record_id: "account:security",
      connection_id: CONNECTION_ID,
      generation_id: GENERATION_ID,
    };
  const holdings = [
    ...(options.manualOnly ? [] : [providerHolding]),
    ...(options.rogueProvider ? [{ ...providerHolding, id: "holding-rogue", connection_id: null }] : []),
    ...(options.includeManual || options.manualOnly ? [{
      id: "holding-manual",
      symbol: "AAPL",
      name: "Apple manual",
      shares: "2",
      cost_basis: "20.00",
      source: "manual",
      authority: "manual",
      currency: "USD",
      reconciliation_state: null,
      retrieved_at: null,
      provider: null,
      provider_record_id: null,
      connection_id: null,
      generation_id: null,
    }] : []),
  ];
  const from = vi.fn((table: string) => {
    if (table === "fund_holdings") return query(holdings);
    if (table === "fund_connections") return query(options.manualOnly ? [] : Array.from({ length: options.connectionCount ?? 1 }, (_, index) => ({
      id: index === 0 ? CONNECTION_ID : `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
      provider: "plaid",
      status: "linked",
      authority: "provider_verified",
      verified_at: retrievedAt,
    })));
    if (table === "fund_provider_coverage") return query(options.manualOnly ? [] : [{
      connection_id: CONNECTION_ID,
      provider: "plaid",
      component: "holdings",
      complete: true,
      record_count: 1,
      retrieved_at: retrievedAt,
      last_attempt_at: retrievedAt,
      availability_status: options.coverageAvailable === false ? "error" : "available",
      availability_reason: options.coverageAvailable === false ? "provider_unavailable" : null,
      generation_id: GENERATION_ID,
      generation_hash: "a".repeat(64),
    }]);
    return query([]);
  });
  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: { id: "user-1" } },
        error: null,
      })),
    },
    from,
    update,
  };
}

describe("holdings read authority boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("derives reconciliation for presentation without mutating provider lineage", async () => {
    const supabase = client();
    mocks.createClient.mockResolvedValue(supabase);

    const response = await GET(new NextRequest("http://axis.test/api/fund/holdings"));

    expect(response.status).toBe(200);
    expect(supabase.update).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({
      rows: [expect.objectContaining({ symbol: "AAPL", reconciliation_state: "matched" })],
      aggregated: [expect.objectContaining({ symbol: "AAPL", reconciliation_state: null })],
    });
  });

  it("rejects a stale opaque subject before reading financial rows", async () => {
    const supabase = client();
    mocks.createClient.mockResolvedValue(supabase);

    const response = await GET(new NextRequest("http://axis.test/api/fund/holdings", {
      headers: { "x-axis-expected-profile-subject": `ps1_${"f".repeat(64)}` },
    }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "SUBJECT_CHANGED" });
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("excludes unavailable provider claims and lets the manual claim remain visible", async () => {
    const supabase = client({ coverageAvailable: false, includeManual: true });
    mocks.createClient.mockResolvedValue(supabase);

    const response = await GET(new NextRequest("http://axis.test/api/fund/holdings"));
    const body = await response.json();

    expect(body).toMatchObject({
      rows: [expect.objectContaining({ id: "holding-manual", authority: "manual" })],
      aggregated: [expect.objectContaining({ symbol: "AAPL", name: "Apple manual" })],
      providerUnavailable: true,
      providerUnavailableReason: "HOLDING_COVERAGE_UNAVAILABLE",
      legacyUnavailableCount: 0,
      withheldProviderCount: 1,
    });
  });

  it("does not claim provider exclusion for a manual-only user with no provider connection", async () => {
    const supabase = client({ manualOnly: true });
    mocks.createClient.mockResolvedValue(supabase);

    const body = await (await GET(new NextRequest("http://axis.test/api/fund/holdings"))).json();

    expect(body.providerUnavailable).toBe(false);
    expect(body.providerUnavailableReason).toBeNull();
    expect(body.rows).toEqual([expect.objectContaining({ authority: "manual" })]);
  });

  it("withholds every provider row when one row is not bound to a verified connection", async () => {
    const supabase = client({ rogueProvider: true, includeManual: true });
    mocks.createClient.mockResolvedValue(supabase);

    const body = await (await GET(new NextRequest("http://axis.test/api/fund/holdings"))).json();

    expect(body.providerUnavailable).toBe(true);
    expect(body.providerUnavailableReason).toBe("HOLDING_PROVENANCE_UNAVAILABLE");
    expect(body.rows).toEqual([expect.objectContaining({ authority: "manual" })]);
  });

  it("rejects connection-list truncation instead of validating a partial universe", async () => {
    const supabase = client({ connectionCount: 33 });
    mocks.createClient.mockResolvedValue(supabase);

    const response = await GET(new NextRequest("http://axis.test/api/fund/holdings"));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reason: "COVERAGE_VERIFICATION_LIMIT_EXCEEDED" });
  });
});
