import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  from: vi.fn(),
  getQuote: vi.fn(),
  isConfigured: vi.fn(),
  explain: vi.fn(),
  redisRateLimit: vi.fn(),
  memoryRateLimit: vi.fn(),
  emit: vi.fn(),
  capture: vi.fn(),
  holdings: [] as { symbol: string; shares: number }[],
  runInserts: [] as Record<string, unknown>[],
  runUpdates: [] as Record<string, unknown>[],
  stepInserts: [] as Record<string, unknown>[],
  tables: [] as string[],
}));

type QueryResult<T> = { data: T; error: unknown };
type MockQuery<T> = PromiseLike<QueryResult<T>> & {
  select: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  single: ReturnType<typeof vi.fn>;
};

function query<T>(result: QueryResult<T>): MockQuery<T> {
  const promise = Promise.resolve(result);
  const value = {
    select: vi.fn(),
    eq: vi.fn(),
    single: vi.fn(async () => result),
    then: promise.then.bind(promise),
  } as unknown as MockQuery<T>;
  value.select.mockReturnValue(value);
  value.eq.mockReturnValue(value);
  return value;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: mocks.getUser },
    from: mocks.from,
  }),
}));
vi.mock("@/lib/markets/adapter", () => ({
  resolveMarketDataAdapter: () => ({
    provider: "test-market",
    isConfigured: mocks.isConfigured,
    getQuote: mocks.getQuote,
  }),
}));
vi.mock("@/lib/ai/explain", () => ({
  explainWithCost: (...args: unknown[]) => mocks.explain(...args),
}));
vi.mock("@/lib/ratelimit", () => ({
  redisRateLimit: (...args: unknown[]) => mocks.redisRateLimit(...args),
  memoryRateLimit: (...args: unknown[]) => mocks.memoryRateLimit(...args),
}));
vi.mock("@/lib/observability/events", () => ({
  emitServerEvent: (...args: unknown[]) => mocks.emit(...args),
}));
vi.mock("@/lib/observability/captureRouteError", () => ({
  captureRouteError: (...args: unknown[]) => mocks.capture(...args),
}));

import { POST } from "./route";

function request(body: unknown) {
  return new NextRequest("http://axis.test/api/routines/rebalance-proposal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function successfulQuote(
  symbol: string,
  price: number,
  freshness: "fresh" | "delayed" = "fresh",
  retrievedAt = "2026-07-16T16:00:00.000Z",
) {
  return {
    ok: true as const,
    data: {
      symbol,
      price,
      currency: "USD",
      changePct: 0,
      freshness,
      provenance: {
        provider: "test-market",
        retrievedAt,
        currency: "USD",
      },
    },
  };
}

describe("POST /api/routines/rebalance-proposal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T16:02:00.000Z"));
    vi.clearAllMocks();
    mocks.holdings.length = 0;
    mocks.runInserts.length = 0;
    mocks.runUpdates.length = 0;
    mocks.stepInserts.length = 0;
    mocks.tables.length = 0;
    mocks.getUser.mockResolvedValue({
      data: { user: { id: "user-1" } },
      error: null,
    });
    mocks.isConfigured.mockReturnValue(true);
    mocks.redisRateLimit.mockResolvedValue({ success: true });
    mocks.memoryRateLimit.mockReturnValue({ success: true });
    mocks.explain.mockResolvedValue({
      skipped: true,
      reason: "no_model_configured",
    });
    mocks.from.mockImplementation((table: string) => {
      mocks.tables.push(table);
      if (table === "routine_runs") {
        return {
          insert: (payload: Record<string, unknown>) => {
            mocks.runInserts.push(payload);
            return query({ data: { id: "run-1" }, error: null });
          },
          update: (payload: Record<string, unknown>) => {
            mocks.runUpdates.push(payload);
            return query({ data: null, error: null });
          },
        };
      }
      if (table === "routine_step_runs") {
        return {
          insert: (payload: Record<string, unknown>) => {
            mocks.stepInserts.push(payload);
            return query({ data: null, error: null });
          },
        };
      }
      if (table === "fund_holdings") {
        return {
          select: () => query({ data: mocks.holdings, error: null }),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    { targets: { AAPL: 1.01 } },
    { targets: { AAPL: 0.7, MSFT: 0.4 } },
    { targets: { AAPL: 0.5 }, driftThreshold: 1.01 },
    { targets: { AAPL: 0.5 }, minTradeValue: -1 },
  ])("rejects unsafe input %# before starting a run", async (body) => {
    const response = await POST(request(body));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "INVALID_ROUTINE_INPUT",
    });
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.getQuote).not.toHaveBeenCalled();
  });

  it("rejects a quote whose retrieval timestamp is materially in the future", async () => {
    mocks.holdings.push({ symbol: "AAPL", shares: 10 });
    mocks.getQuote.mockResolvedValue(
      successfulQuote("AAPL", 100, "fresh", "2026-07-16T16:04:00.000Z"),
    );

    const response = await POST(request({ targets: { AAPL: 1 } }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "MARKET_DATA_INCOMPLETE",
      runId: "run-1",
      resumable: false,
    });
    expect(mocks.stepInserts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        step_key: "load_prices",
        status: "failed",
        output_snapshot: expect.objectContaining({
          failureCodes: ["invalid_quote"],
        }),
      }),
    ]));
  });

  it("rate limits before starting provider or database work", async () => {
    mocks.redisRateLimit.mockResolvedValue({ success: false });

    const response = await POST(request({ targets: { AAPL: 1 } }));

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({
      error: "RATE_LIMITED",
      message: "Too many rebalance simulations. Try again in a minute.",
    });
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.getQuote).not.toHaveBeenCalled();
    expect(mocks.memoryRateLimit).not.toHaveBeenCalled();
  });

  it("fails closed and blocks the run when only part of the required quote set succeeds", async () => {
    mocks.holdings.push({ symbol: "AAPL", shares: 10 });
    mocks.getQuote.mockImplementation(async (symbol: string) => {
      if (symbol === "AAPL") return successfulQuote("AAPL", 100);
      return {
        ok: false as const,
        error: {
          code: "network" as const,
          message: "provider detail that must not be surfaced",
          retryable: true,
          provider: "test-market",
        },
      };
    });

    const response = await POST(request({
      targets: { AAPL: 0.5, MSFT: 0.4 },
    }));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({
      error: "MARKET_DATA_INCOMPLETE",
      message: "A complete set of positive fresh or delayed USD quotes is required. No proposal was produced.",
      runId: "run-1",
      resumable: false,
      retryStrategy: "start_new_run",
    });
    expect(JSON.stringify(body)).not.toContain("provider detail");
    expect(mocks.stepInserts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        step_key: "load_prices",
        status: "failed",
        error: "MARKET_DATA_INCOMPLETE",
        output_snapshot: expect.objectContaining({
          requiredQuotes: 2,
          acceptedQuotes: 1,
          failureCount: 1,
          failureCodes: ["network"],
        }),
      }),
    ]));
    expect(mocks.runUpdates).toContainEqual({
      status: "blocked",
      error: "MARKET_DATA_INCOMPLETE",
    });
    expect(mocks.capture).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        operation: "load_prices",
        provider: "test-market",
        status: 503,
        code: "MARKET_DATA_INCOMPLETE",
        tags: {
          requiredQuotes: 2,
          acceptedQuotes: 1,
          failureCount: 1,
          failureCodes: "network",
        },
      }),
    );
    expect(JSON.stringify(mocks.capture.mock.calls)).not.toContain("provider detail");
  });

  it("persists and returns a completed simulation with full unsubmitted order drafts", async () => {
    mocks.holdings.push({ symbol: "aapl", shares: 10 });
    mocks.getQuote.mockImplementation(async (symbol: string) => {
      if (symbol === "AAPL") {
        return successfulQuote("AAPL", 100, "fresh", "2026-07-16T16:01:00.000Z");
      }
      return successfulQuote("MSFT", 50, "delayed", "2026-07-16T15:55:00.000Z");
    });

    const response = await POST(request({
      targets: { aapl: 0.5, MSFT: 0.4 },
      driftThreshold: 0,
      minTradeValue: 0,
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      runId: "run-1",
      status: "completed",
      mode: "simulate",
      simulationOnly: true,
      proposed: 2,
      submissionEnabled: false,
      approvalRequiredForSubmission: true,
      executionStatus: "not_submitted",
      targetAllocation: {
        targetWeightTotal: 0.9,
        cashRemainderWeight: 0.1,
        cashRemainderPolicy: "unallocated_target_weight_is_cash",
        allocationIntent: "partial_cash",
        basis: "invested_holdings_market_value",
      },
      quoteSet: {
        provider: "test-market",
        freshness: "delayed",
        oldestRetrievedAt: "2026-07-16T15:55:00.000Z",
      },
    });
    expect(body.orderDrafts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        symbol: "AAPL",
        side: "sell",
        tradeValue: 500,
        executionStatus: "not_submitted",
        ticket: expect.objectContaining({
          symbol: "AAPL",
          side: "sell",
          quantity: 5,
          referencePrice: 100,
          estimatedNotional: 500,
          currency: "USD",
        }),
      }),
      expect.objectContaining({
        symbol: "MSFT",
        side: "buy",
        tradeValue: 400,
        executionStatus: "not_submitted",
        ticket: expect.objectContaining({
          symbol: "MSFT",
          side: "buy",
          quantity: 8,
          referencePrice: 50,
          estimatedNotional: 400,
          currency: "USD",
        }),
      }),
    ]));

    const completed = mocks.runUpdates.find((update) => update.status === "completed");
    expect(completed).toMatchObject({
      status: "completed",
      actual_cost_usd: 0,
      output: {
        mode: "simulate",
        orderDrafts: body.orderDrafts,
        submissionEnabled: false,
        approvalRequiredForSubmission: true,
        executionStatus: "not_submitted",
      },
      error: null,
    });
    expect(mocks.stepInserts.map((step) => step.step_key)).toEqual([
      "load_holdings",
      "load_prices",
      "propose_rebalance",
    ]);
    expect(mocks.explain).not.toHaveBeenCalled();
    expect(mocks.tables).not.toContain("approvals");
    expect(mocks.runInserts[0]).toMatchObject({
      routine_key: "rebalance_proposal",
      routine_version: 2,
      status: "running",
      input_snapshot: {
        mode: "simulate",
        submissionEnabled: false,
        approvalRequiredForSubmission: true,
        targetAllocation: {
          targetWeightTotal: 0.9,
          cashRemainderWeight: 0.1,
          cashRemainderPolicy: "unallocated_target_weight_is_cash",
          allocationIntent: "partial_cash",
        },
      },
    });
  });

  it("documents a zero-weight target set as an all-cash simulation", async () => {
    mocks.holdings.push({ symbol: "AAPL", shares: 10 });
    mocks.getQuote.mockResolvedValue(successfulQuote("AAPL", 100));

    const response = await POST(request({
      targets: { AAPL: 0 },
      driftThreshold: 0,
      minTradeValue: 0,
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.targetAllocation).toMatchObject({
      targetWeightTotal: 0,
      cashRemainderWeight: 1,
      allocationIntent: "all_cash",
      cashRemainderPolicy: "unallocated_target_weight_is_cash",
    });
    expect(body.orderDrafts).toEqual([
      expect.objectContaining({
        symbol: "AAPL",
        side: "sell",
        tradeValue: 1000,
        executionStatus: "not_submitted",
      }),
    ]);
  });
});
