import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const mocks = vi.hoisted(() => ({
  getPlaidCreds: vi.fn(),
  plaidRequest: vi.fn(),
  admitPlaidRequest: vi.fn(),
}));

vi.mock("@/app/api/plaid/_lib", () => ({
  getPlaidCreds: mocks.getPlaidCreds,
}));
vi.mock("@/lib/plaid/request", () => ({
  plaidRequest: mocks.plaidRequest,
  isPlainPlaidRecord: (value: unknown) =>
    Boolean(value) && typeof value === "object" && !Array.isArray(value),
}));
vi.mock("@/lib/plaid/admission", () => ({
  admitPlaidRequest: mocks.admitPlaidRequest,
}));

import { syncPlaidBalanceSheet } from "./syncPlaidBalanceSheet";

const connection = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  accessToken: "token",
  itemId: "item-1",
};

function admin(rpcImpl?: (name: string, params: Record<string, unknown>) => unknown) {
  const rpc = vi.fn(async (name: string, params: Record<string, unknown>) => ({
    data: rpcImpl
      ? rpcImpl(name, params)
      : name.startsWith("publish_")
        ? [{
            record_count: Array.isArray(params.p_rows) ? params.p_rows.length : -1,
            generation_hash: "a".repeat(64),
          }]
        : true,
    error: null,
  }));
  return { client: { rpc } as unknown as SupabaseClient, rpc };
}

function item(billed: string[], consented: string[] = []) {
  return {
    request_id: "request",
    item: {
      item_id: "item-1",
      billed_products: billed,
      consented_products: consented,
    },
  };
}

function holdingPayload(costBasis: unknown = "10.00") {
  return {
    request_id: "holdings",
    item: { item_id: "item-1" },
    securities: [{ security_id: "security-1", ticker_symbol: "AAPL", name: "Apple" }],
    holdings: [{
      account_id: "account-1",
      security_id: "security-1",
      quantity: "1.25",
      cost_basis: costBasis,
      iso_currency_code: "USD",
    }],
  };
}

function liabilityPayload(minimumPayment: unknown = "25.00") {
  return {
    request_id: "liabilities",
    item: { item_id: "item-1" },
    accounts: [{
      account_id: "credit-1",
      name: "Card",
      balances: { current: "100.00", iso_currency_code: "USD" },
    }],
    liabilities: {
      credit: [{
        account_id: "credit-1",
        minimum_payment_amount: minimumPayment,
        next_payment_due_date: "2026-08-01",
      }],
      student: [],
      mortgage: [],
    },
  };
}

describe("Plaid balance-sheet publication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPlaidCreds.mockReturnValue({ clientId: "client", secret: "secret", env: "sandbox" });
    mocks.admitPlaidRequest.mockResolvedValue("allowed");
  });

  it("never treats consent alone as autonomous billing authority", async () => {
    mocks.plaidRequest.mockResolvedValueOnce(item([], ["investments", "liabilities"]));
    const db = admin();
    const result = await syncPlaidBalanceSheet(db.client, "user-1", connection);

    expect(result).toMatchObject({
      ok: true,
      holdings: { status: "unavailable", reason: "product_not_billed" },
      liabilities: { status: "unavailable", reason: "product_not_billed" },
    });
    expect(mocks.plaidRequest).toHaveBeenCalledTimes(1);
    expect(db.rpc).toHaveBeenCalledTimes(2);
  });

  it("publishes a billed holdings component while marking liabilities independently unavailable", async () => {
    mocks.plaidRequest
      .mockResolvedValueOnce(item(["investments"]))
      .mockResolvedValueOnce(holdingPayload());
    const db = admin();
    const result = await syncPlaidBalanceSheet(db.client, "user-1", connection);

    expect(result).toMatchObject({
      ok: true,
      holdings: { status: "published", recordCount: 1 },
      liabilities: { status: "unavailable", reason: "product_not_billed" },
    });
    expect(db.rpc.mock.calls.map(([name]) => name)).toEqual(expect.arrayContaining([
      "publish_fund_holding_generation",
      "mark_fund_provider_component_unavailable",
    ]));
  });

  it("fails closed on malformed RPC success and records the failed attempt", async () => {
    mocks.plaidRequest
      .mockResolvedValueOnce(item(["investments"]))
      .mockResolvedValueOnce(holdingPayload());
    const db = admin((name) =>
      name === "publish_fund_holding_generation"
        ? [{ record_count: 1, generation_hash: "not-a-hash" }]
        : true,
    );
    const result = await syncPlaidBalanceSheet(db.client, "user-1", connection);

    expect(result).toMatchObject({
      ok: true,
      holdings: { status: "unavailable", reason: "publish_failed" },
    });
  });

  it("rejects non-null malformed optional liability money instead of converting it to absence", async () => {
    mocks.plaidRequest
      .mockResolvedValueOnce(item(["liabilities"]))
      .mockResolvedValueOnce(liabilityPayload("25.001"));
    const db = admin();
    const result = await syncPlaidBalanceSheet(db.client, "user-1", connection);

    expect(result).toMatchObject({
      ok: true,
      liabilities: { status: "unavailable", reason: "payload_incomplete" },
    });
    expect(db.rpc.mock.calls.some(([name]) => name === "publish_fund_liability_generation")).toBe(false);
  });

  it("does not claim complete holdings when a provider row lacks a valuing fact", async () => {
    mocks.plaidRequest
      .mockResolvedValueOnce(item(["investments"]))
      .mockResolvedValueOnce(holdingPayload(null));
    const db = admin();
    const result = await syncPlaidBalanceSheet(db.client, "user-1", connection);

    expect(result).toMatchObject({
      ok: true,
      holdings: { status: "unavailable", reason: "payload_incomplete" },
    });
  });
});
