import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: mocks.createClient,
}));

import { GET, POST } from "./route";

type Snapshot = Record<string, unknown>;

function client(rows: Snapshot[], queryError: unknown = null) {
  const filters: Array<[string, unknown]> = [];
  const chain: Record<string, unknown> = {};
  chain.select = vi.fn(() => chain);
  chain.eq = vi.fn((column: string, value: unknown) => {
    filters.push([column, value]);
    return chain;
  });
  chain.gte = vi.fn(() => chain);
  chain.order = vi.fn(() => chain);
  chain.then = (
    resolve: (value: { data: Snapshot[]; error: unknown }) => unknown,
    reject: (reason: unknown) => unknown,
  ) => Promise.resolve({
    data: rows.filter((row) => filters.every(([column, value]) => row[column] === value)),
    error: queryError,
  }).then(resolve, reject);
  const from = vi.fn(() => chain);
  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: { id: "user-1" } },
        error: null,
      })),
    },
    from,
    filters,
  };
}

describe("net-worth authority boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns only complete provider-authoritative v2 USD snapshots from the exact view", async () => {
    const provider = {
      captured_on: "2026-07-23",
      cash: "100.00",
      invested: "200.00",
      liabilities: "50.00",
      net_worth: "250.00",
      user_id: "user-1",
      authority: "provider",
      snapshot_status: "fresh",
      currency: "USD",
      calculation_version: "financial-truth-v2",
      calculation_hash: "a".repeat(64),
      computed_at: "2026-07-23T12:01:00.000Z",
      input_as_of: "2026-07-23T12:00:00.000Z",
    };
    const legacy = {
      ...provider,
      captured_on: "2026-07-22",
      cash: 0,
      invested: 0,
      liabilities: 0,
      net_worth: 0,
      authority: "legacy_unknown",
      snapshot_status: "legacy_unknown",
      currency: null,
      calculation_version: "legacy_unknown",
    };
    const supabase = client([legacy, provider]);
    mocks.createClient.mockResolvedValue(supabase);

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ snapshots: [provider] });
    expect(supabase.from).toHaveBeenCalledWith("net_worth_snapshots_exact");
    expect(supabase.filters).toEqual(expect.arrayContaining([
      ["authority", "provider"],
      ["snapshot_status", "fresh"],
      ["currency", "USD"],
      ["calculation_version", "financial-truth-v2"],
    ]));
  });

  it("rejects every browser snapshot POST without opening an authenticated database client", async () => {
    const response = await POST(new NextRequest("http://axis.test/api/fund/networth", {
      method: "POST",
      body: JSON.stringify({ cash: 0, invested: 0, liabilities: 0 }),
    }));

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET");
    expect(await response.json()).toEqual({ error: "SNAPSHOT_WRITES_SERVER_ONLY" });
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it("returns an error instead of fabricated empty or zero snapshots on database failure", async () => {
    mocks.createClient.mockResolvedValue(client([], new Error("database unavailable")));

    const response = await GET();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "SNAPSHOTS_UNAVAILABLE" });
  });
});
