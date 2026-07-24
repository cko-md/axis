import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FinancialSnapshotOutcome } from "./financialTruth";

const mocks = vi.hoisted(() => ({
  decrypt: vi.fn(),
  getPlaidCreds: vi.fn(),
  timedProviderFetch: vi.fn(),
  getPolygonApiKey: vi.fn(),
  fetchSnapshot: vi.fn(),
  notifyViaMake: vi.fn(),
  plaidRequest: vi.fn(),
  syncPlaidBalanceSheet: vi.fn(),
  admitPlaidRequest: vi.fn(),
}));

vi.mock("@/lib/crypto", () => ({ decrypt: mocks.decrypt }));
vi.mock("@/app/api/plaid/_lib", () => ({
  getPlaidCreds: mocks.getPlaidCreds,
  plaidHost: () => "https://plaid.invalid",
}));
vi.mock("@/lib/observability/providerTiming", () => ({
  timedProviderFetch: mocks.timedProviderFetch,
}));
vi.mock("@/lib/massive/client", () => ({
  getPolygonApiKey: mocks.getPolygonApiKey,
  fetchSnapshot: mocks.fetchSnapshot,
}));
vi.mock("@/lib/fund/notifyViaMake", () => ({
  notifyViaMake: mocks.notifyViaMake,
}));
vi.mock("@/lib/plaid/request", () => ({
  plaidRequest: mocks.plaidRequest,
  isPlainPlaidRecord: (value: unknown) => Boolean(value) && typeof value === "object" && !Array.isArray(value),
}));
vi.mock("@/lib/fund/syncPlaidBalanceSheet", () => ({
  syncPlaidBalanceSheet: mocks.syncPlaidBalanceSheet,
}));
vi.mock("@/lib/plaid/admission", () => ({
  admitPlaidRequest: mocks.admitPlaidRequest,
}));

import { snapshotNetWorth, writeDailyBrief } from "./financeDailyJobs";

const NOW = "2026-07-23T12:00:00.000Z";

type DbResult = { data: unknown; error: unknown };

function query(result: DbResult, selected: string[]) {
  const chain: Record<string, unknown> = {};
  chain.select = vi.fn((fields: string) => {
    selected.push(fields);
    return chain;
  });
  for (const method of ["eq", "order", "limit", "lt", "gte"]) {
    chain[method] = vi.fn(() => chain);
  }
  chain.then = (
    resolve: (value: DbResult) => unknown,
    reject: (reason: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  return chain;
}

function makeAdmin(overrides: {
  connections?: unknown[];
  holdings?: unknown[];
  liabilities?: unknown[];
  coverage?: unknown[];
  snapshots?: unknown[];
} = {}) {
  const selected: string[] = [];
  const upserts: unknown[] = [];
  const inserts: unknown[] = [];
  const rows: Record<string, unknown[]> = {
    fund_connections: overrides.connections ?? [{
      id: "connection-1",
      provider: "plaid",
      status: "linked",
      authority: "provider_verified",
      verified_at: NOW,
      access_token_enc: "encrypted-token",
      item_id: "item-1",
    }],
    fund_holdings: overrides.holdings ?? [{
      symbol: "AAPL",
      shares: "1.005",
      source: "plaid",
      authority: "provider",
      provider: "plaid",
      provider_record_id: "holding-aapl",
      connection_id: "connection-1",
      generation_id: "11111111-1111-4111-8111-111111111111",
      retrieved_at: NOW,
      currency: "USD",
      reconciliation_state: "matched",
    }],
    fund_liabilities: overrides.liabilities ?? [{
      balance: "10.00",
      source: "plaid",
      authority: "provider",
      provider: "plaid",
      provider_record_id: "liability-1",
      connection_id: "connection-1",
      retrieved_at: NOW,
      currency: "USD",
      reconciliation_state: "matched",
      generation_id: "22222222-2222-4222-8222-222222222222",
    }],
    fund_provider_coverage: overrides.coverage ?? [
      {
        connection_id: "connection-1",
        provider: "plaid",
        component: "holdings",
        complete: true,
        record_count: 1,
        retrieved_at: NOW,
        generation_id: "11111111-1111-4111-8111-111111111111",
        generation_hash: "a".repeat(64),
        availability_status: "available",
      },
      {
        connection_id: "connection-1",
        provider: "plaid",
        component: "liabilities",
        complete: true,
        record_count: 1,
        retrieved_at: NOW,
        generation_id: "22222222-2222-4222-8222-222222222222",
        generation_hash: "b".repeat(64),
        availability_status: "available",
      },
    ],
    net_worth_snapshots: overrides.snapshots ?? [],
    net_worth_snapshots_exact: overrides.snapshots ?? [],
  };

  const from = vi.fn((table: string) => {
    const chain = query({ data: rows[table] ?? [], error: null }, selected) as Record<string, unknown>;
    chain.upsert = vi.fn(async (payload: unknown) => {
      upserts.push(payload);
      return { error: null };
    });
    chain.insert = vi.fn(async (payload: unknown) => {
      inserts.push(payload);
      return { error: null };
    });
    return chain;
  });

  return {
    admin: { from } as unknown as SupabaseClient,
    from,
    selected,
    upserts,
    inserts,
  };
}

function plaidResponse(accounts: unknown[]) {
  return new Response(JSON.stringify({ accounts }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const freshSnapshot: FinancialSnapshotOutcome = {
  status: "fresh",
  authority: "provider",
  currency: "USD",
  cashMinor: 12_345,
  investedMinor: 1_005,
  liabilitiesMinor: 1_000,
  netWorthMinor: 12_350,
};

describe("finance daily job financial-truth faults", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    vi.clearAllMocks();
    mocks.decrypt.mockReturnValue("provider-token");
    mocks.getPlaidCreds.mockReturnValue({
      clientId: "client",
      secret: "secret",
      env: "sandbox",
    });
    mocks.getPolygonApiKey.mockReturnValue("polygon-key");
    mocks.admitPlaidRequest.mockResolvedValue("allowed");
    mocks.syncPlaidBalanceSheet.mockResolvedValue({
      ok: true,
      holdings: { status: "published", recordCount: 1 },
      liabilities: { status: "published", recordCount: 1 },
    });
    mocks.fetchSnapshot.mockResolvedValue({
      price: "10.00",
      chg: 0,
      source: "massive",
      asOf: NOW,
    });
    mocks.plaidRequest.mockResolvedValue({
      request_id: "request",
      item: { item_id: "item-1" },
      accounts: [{
        type: "depository",
        balances: { current: "123.45", iso_currency_code: "USD" },
      }],
    });
    mocks.notifyViaMake.mockResolvedValue({
      sent: true,
      status: 202,
      deliveryId: "delivery",
      deduped: false,
      auditRecorded: true,
      outboxRecorded: true,
    });
  });

  it("persists an exact provider snapshot, including a legitimate zero cash balance", async () => {
    mocks.plaidRequest.mockResolvedValue({
      request_id: "request",
      item: { item_id: "item-1" },
      accounts: [{
        type: "depository",
        balances: { current: 0, iso_currency_code: "USD" },
      }],
    });
    const db = makeAdmin();

    const outcome = await snapshotNetWorth(db.admin, "user-1");

    expect(outcome).toEqual({
      status: "fresh",
      authority: "provider",
      currency: "USD",
      cashMinor: 0,
      investedMinor: 1_005,
      liabilitiesMinor: 1_000,
      netWorthMinor: 5,
    });
    expect(db.upserts).toEqual([expect.objectContaining({
      cash: "0.00",
      invested: "10.05",
      liabilities: "10.00",
      net_worth: "0.05",
      calculation_version: "financial-truth-v2",
      calculation_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      input_as_of: NOW,
    })]);
  });

  it.each([
    ["missing balance", [{ type: "depository" }], "plaid_balance_invalid"],
    ["mixed currency", [{ type: "depository", balances: { current: "1.00", iso_currency_code: "EUR" } }], "plaid_balance_invalid_or_mixed_currency"],
  ])("declines %s rather than persisting numeric zero", async (_label, accounts, reason) => {
    mocks.plaidRequest.mockResolvedValue({
      request_id: "request",
      item: { item_id: "item-1" },
      accounts,
    });
    const db = makeAdmin();

    const outcome = await snapshotNetWorth(db.admin, "user-1");

    expect(outcome).toMatchObject({ status: "error", reason });
    expect(db.upserts).toHaveLength(0);
  });

  it("declines an unavailable market quote and never selects cost basis as a quote substitute", async () => {
    mocks.fetchSnapshot.mockRejectedValue(new Error("provider unavailable"));
    const db = makeAdmin();

    const outcome = await snapshotNetWorth(db.admin, "user-1");

    expect(outcome).toMatchObject({
      status: "stale",
      reason: "market_quote_provenance_not_fresh",
    });
    expect(db.upserts).toHaveLength(0);
    expect(db.selected.some((fields) => fields.includes("cost_basis"))).toBe(false);
  });

  it.each([
    ["empty provider coverage", { holdings: [], liabilities: [] }, "holding_provider_coverage_missing"],
    ["manual holding authority", {
      holdings: [{
        symbol: "AAPL",
        shares: "1",
        source: "manual",
        provider: "manual",
        retrieved_at: NOW,
        currency: "USD",
        reconciliation_state: "matched",
      }],
    }, "holding_not_provider_authoritative"],
    ["stale liability provenance", {
      liabilities: [{
        balance: "10",
        source: "plaid",
        authority: "provider",
        provider: "plaid",
        provider_record_id: "liability-1",
        connection_id: "connection-1",
        generation_id: "22222222-2222-4222-8222-222222222222",
        retrieved_at: "2026-07-20T00:00:00.000Z",
        currency: "USD",
        reconciliation_state: "matched",
      }],
    }, "liability_provenance_not_fresh"],
  ])("declines %s without persisting partial truth", async (_label, overrides, reason) => {
    const db = makeAdmin(overrides);

    const outcome = await snapshotNetWorth(db.admin, "user-1");

    expect(outcome).toMatchObject({ reason });
    expect(db.upserts).toHaveLength(0);
  });

  it("does not write or notify a high-confidence brief from a declined snapshot", async () => {
    const from = vi.fn(() => {
      throw new Error("database must not be read");
    });
    const declined: FinancialSnapshotOutcome = {
      status: "missing",
      authority: "provider",
      currency: "USD",
      reason: "holding_provider_coverage_missing",
    };

    const outcome = await writeDailyBrief(
      { from } as unknown as SupabaseClient,
      "user-1",
      "person@example.com",
      declined,
    );

    expect(outcome).toEqual({ attempted: 0, failed: 0, results: [] });
    expect(from).not.toHaveBeenCalled();
    expect(mocks.notifyViaMake).not.toHaveBeenCalled();
  });

  it("propagates delivery without durable audit evidence as a failed notification outcome", async () => {
    mocks.notifyViaMake.mockResolvedValue({
      sent: true,
      status: 202,
      deliveryId: "delivery",
      deduped: false,
      auditRecorded: false,
      outboxRecorded: true,
    });
    const db = makeAdmin({
      snapshots: [
        { captured_on: "2026-07-23", net_worth: "123.45", currency: "USD" },
        { captured_on: "2026-07-16", net_worth: "120.00", currency: "USD" },
      ],
    });

    const outcome = await writeDailyBrief(
      db.admin,
      "user-1",
      "person@example.com",
      freshSnapshot,
    );

    expect(db.inserts).toHaveLength(1);
    expect(outcome).toMatchObject({ attempted: 1, failed: 1 });
  });

  it("uses an absolute change instead of inventing a percentage from a nonpositive baseline", async () => {
    const db = makeAdmin({
      snapshots: [
        { captured_on: "2026-07-23", net_worth: "100.00", currency: "USD" },
        { captured_on: "2026-07-16", net_worth: "0.00", currency: "USD" },
      ],
    });

    await writeDailyBrief(db.admin, "user-1", null, freshSnapshot);

    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0]).toMatchObject({
      body: expect.stringContaining(
        "increased by $100.00 since 2026-07-16, now $100.00. Percentage change is unavailable",
      ),
    });
    expect(JSON.stringify(db.inserts[0])).not.toContain("Infinity");
  });
});
