import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: mocks.createClient,
}));

import { GET } from "./route";

function client() {
  const update = vi.fn();
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq", "order"]) chain[method] = vi.fn(() => chain);
  chain.update = update;
  chain.then = (
    resolve: (value: { data: unknown[]; error: null }) => unknown,
    reject: (reason: unknown) => unknown,
  ) => Promise.resolve({
    data: [{
      id: "holding-1",
      symbol: "AAPL",
      name: "Apple",
      shares: "1",
      cost_basis: "10.00",
      source: "plaid",
      authority: "provider",
      currency: "USD",
      reconciliation_state: "matched",
      retrieved_at: "2026-07-23T12:00:00.000Z",
    }],
    error: null,
  }).then(resolve, reject);
  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: { id: "user-1" } },
        error: null,
      })),
    },
    from: vi.fn(() => chain),
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
});
