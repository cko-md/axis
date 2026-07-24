import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  getPolygonApiKey: vi.fn(),
  fetchSnapshot: vi.fn(),
  fetchNews: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: mocks.createClient,
}));
vi.mock("@/lib/massive/client", () => ({
  getPolygonApiKey: mocks.getPolygonApiKey,
  fetchSnapshot: mocks.fetchSnapshot,
  fetchNews: mocks.fetchNews,
}));
vi.mock("@/lib/observability/redactRouteError", () => ({
  redactRouteError: () => NextResponse.json({ error: "POSITION_DATA_UNAVAILABLE" }, { status: 500 }),
}));

import { GET } from "./route";

type QueryResult = { data: unknown[] | null; error: unknown };

function query(result: QueryResult) {
  const chain: Record<string, unknown> = {};
  chain.select = vi.fn(() => chain);
  chain.eq = vi.fn(() => chain);
  chain.limit = vi.fn(() => chain);
  chain.then = (
    resolve: (value: QueryResult) => unknown,
    reject: (reason: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  return chain;
}

function client(
  target: QueryResult,
  portfolio: QueryResult,
  connections: QueryResult = { data: [{
    id: "connection-1",
    provider: "plaid",
    status: "linked",
    authority: "provider_verified",
    verified_at: new Date().toISOString(),
  }], error: null },
) {
  let read = 0;
  const results = [target, portfolio, connections];
  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: { id: "user-1" } },
        error: null,
      })),
    },
    from: vi.fn(() => query(results[read++] ?? { data: [], error: null })),
  };
}

function request() {
  return new NextRequest("http://axis.test/api/fund/position/AAPL");
}

function invoke() {
  return GET(request(), { params: Promise.resolve({ symbol: "AAPL" }) });
}

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
};

describe("position route live-value faults", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPolygonApiKey.mockReturnValue("polygon-key");
    mocks.fetchNews.mockResolvedValue([]);
  });

  it("returns null live metrics and a typed reason when the quote is unavailable", async () => {
    mocks.createClient.mockResolvedValue(client(
      { data: [aapl], error: null },
      { data: [aapl], error: null },
    ));
    mocks.fetchSnapshot.mockRejectedValue(new Error("quote unavailable"));

    const response = await invoke();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      symbol: "AAPL",
      shares: "2.000000",
      sharesMicro: 2_000_000,
      costBasis: "100.00",
      costBasisMinor: 10_000,
      quote: null,
      liveAvailable: false,
      liveReason: "QUOTE_UNAVAILABLE",
      positionValue: null,
      unrealizedPL: null,
      weight: null,
    });
    expect(body.positionValue).not.toBe(body.costBasis);
  });

  it("does not serialize a missing position as numeric zero", async () => {
    mocks.createClient.mockResolvedValue(client(
      { data: [], error: null },
      { data: [], error: null },
    ));
    mocks.fetchSnapshot.mockRejectedValue(new Error("not found"));

    const body = await (await invoke()).json();

    expect(body).toMatchObject({
      liveAvailable: false,
      liveReason: "POSITION_NOT_FOUND",
      shares: null,
      costBasis: null,
      positionValue: null,
      unrealizedPL: null,
      weight: null,
    });
  });

  it("withholds live metrics when another portfolio quote is missing", async () => {
    const msft = {
      symbol: "MSFT",
      shares: "1",
      cost_basis: "50",
      source: "plaid",
      currency: "USD",
      authority: "provider",
      provider: "plaid",
      provider_record_id: "holding-msft",
      connection_id: "connection-1",
      retrieved_at: new Date().toISOString(),
      reconciliation_state: "matched",
    };
    mocks.createClient.mockResolvedValue(client(
      { data: [aapl], error: null },
      { data: [aapl, msft], error: null },
    ));
    mocks.fetchSnapshot.mockImplementation(async (symbol: string) => {
      if (symbol === "AAPL") return { price: 75, chg: 1, source: "massive", asOf: new Date().toISOString() };
      throw new Error("MSFT quote unavailable");
    });

    const body = await (await invoke()).json();

    expect(body).toMatchObject({
      quote: {
        price: "75.00",
        priceMinor: 7_500,
        changePercent: 1,
        source: "massive",
      },
      liveAvailable: false,
      liveReason: "PORTFOLIO_QUOTES_INCOMPLETE",
      positionValue: null,
      unrealizedPL: null,
      weight: null,
    });
  });

  it("returns a visible route error when portfolio coverage cannot be loaded", async () => {
    mocks.createClient.mockResolvedValue(client(
      { data: [aapl], error: null },
      { data: null, error: new Error("database unavailable") },
    ));

    const response = await invoke();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "POSITION_DATA_UNAVAILABLE" });
    expect(mocks.fetchSnapshot).not.toHaveBeenCalled();
  });
});
