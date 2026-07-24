import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  optionalEnv: vi.fn(),
  createAdminClient: vi.fn(),
  encryptionReady: vi.fn(),
  decrypt: vi.fn(),
  syncPlaidTransactions: vi.fn(),
  snapshotNetWorth: vi.fn(),
  detectRecurring: vi.fn(),
  writeDailyBrief: vi.fn(),
  sendBillReminders: vi.fn(),
  checkBudgetThresholds: vi.fn(),
  detectAndExplainAnomalies: vi.fn(),
  writeWeeklyRecap: vi.fn(),
  writeSubscriptionAudit: vi.fn(),
}));

vi.mock("@/lib/env", () => ({
  optionalEnv: mocks.optionalEnv,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: mocks.createAdminClient,
}));
vi.mock("@/lib/integrations/makeOutbox", () => ({
  isMakeOutboxEncryptionReady: mocks.encryptionReady,
}));
vi.mock("@/lib/crypto", () => ({
  decrypt: mocks.decrypt,
}));
vi.mock("@/lib/fund/syncPlaidTransactions", () => ({
  syncPlaidTransactions: mocks.syncPlaidTransactions,
}));
vi.mock("@/lib/fund/financeDailyJobs", () => ({
  snapshotNetWorth: mocks.snapshotNetWorth,
  detectRecurring: mocks.detectRecurring,
  writeDailyBrief: mocks.writeDailyBrief,
  sendBillReminders: mocks.sendBillReminders,
}));
vi.mock("@/lib/fund/financeNarratorJobs", () => ({
  checkBudgetThresholds: mocks.checkBudgetThresholds,
  detectAndExplainAnomalies: mocks.detectAndExplainAnomalies,
  writeWeeklyRecap: mocks.writeWeeklyRecap,
  writeSubscriptionAudit: mocks.writeSubscriptionAudit,
}));

import { GET } from "./route";

const SECRET = "finance-secret";
const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type QueryResult = { data: unknown; error: unknown };

function query(result: QueryResult) {
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq", "limit"]) chain[method] = vi.fn(() => chain);
  chain.then = (
    resolve: (value: QueryResult) => unknown,
    reject: (reason: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  return chain;
}

function adminClient(options: {
  connections?: QueryResult;
  users?: QueryResult;
  holdingUsers?: QueryResult;
  authError?: unknown;
} = {}) {
  let connectionReads = 0;
  const from = vi.fn((table: string) => {
    if (table === "fund_connections") {
      const result = connectionReads++ === 0
        ? options.connections ?? {
          data: [{ id: "connection-1", user_id: USER_ID, access_token_enc: "encrypted" }],
          error: null,
        }
        : options.users ?? { data: [{ user_id: USER_ID }], error: null };
      return query(result);
    }
    if (table === "fund_holdings") {
      return query(options.holdingUsers ?? { data: [{ user_id: USER_ID }], error: null });
    }
    if ([
      "fund_liabilities",
      "fund_bank_transactions",
      "fund_category_budgets",
      "fund_recurring_transactions",
    ].includes(table)) {
      return query({ data: [], error: null });
    }
    throw new Error(`Unexpected table ${table}`);
  });
  return {
    from,
    auth: {
      admin: {
        getUserById: vi.fn(async () => options.authError
          ? { data: null, error: options.authError }
          : { data: { user: { id: USER_ID, email: "person@example.com" } }, error: null }),
      },
    },
  };
}

function request() {
  return new NextRequest("http://axis.test/api/cron/finance-daily", {
    headers: { authorization: `Bearer ${SECRET}` },
  });
}

const completeNotification = { attempted: 0, failed: 0, results: [] };
const freshSnapshot = {
  status: "fresh",
  authority: "provider",
  currency: "USD",
  cashMinor: 10_000,
  investedMinor: 20_000,
  liabilitiesMinor: 5_000,
  netWorthMinor: 25_000,
};

describe("finance daily cron fault aggregation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.optionalEnv.mockImplementation((key: string) => key === "CRON_SECRET" ? SECRET : undefined);
    mocks.createAdminClient.mockReturnValue(adminClient());
    mocks.encryptionReady.mockReturnValue(true);
    mocks.decrypt.mockReturnValue("provider-token");
    mocks.syncPlaidTransactions.mockResolvedValue({ synced: 1 });
    mocks.snapshotNetWorth.mockResolvedValue(freshSnapshot);
    mocks.detectRecurring.mockResolvedValue(undefined);
    mocks.writeDailyBrief.mockResolvedValue(completeNotification);
    mocks.sendBillReminders.mockResolvedValue(completeNotification);
    mocks.checkBudgetThresholds.mockResolvedValue(completeNotification);
    mocks.detectAndExplainAnomalies.mockResolvedValue(completeNotification);
    mocks.writeWeeklyRecap.mockResolvedValue(completeNotification);
    mocks.writeSubscriptionAudit.mockResolvedValue(completeNotification);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fails closed before provider or database work when private outbox encryption is unavailable", async () => {
    const admin = adminClient();
    mocks.createAdminClient.mockReturnValue(admin);
    mocks.encryptionReady.mockReturnValue(false);

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({
      ok: false,
      outcome: "systemic_failure",
      error: "OUTBOX_ENCRYPTION_UNAVAILABLE",
    });
    expect(admin.from).not.toHaveBeenCalled();
    expect(mocks.snapshotNetWorth).not.toHaveBeenCalled();
  });

  it("reports an accepted-but-unaudited notification as a partial run", async () => {
    mocks.writeDailyBrief.mockResolvedValue({
      attempted: 1,
      failed: 1,
      results: [{
        sent: true,
        status: 202,
        deliveryId: "delivery",
        deduped: false,
        auditRecorded: false,
        outboxRecorded: true,
      }],
    });

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      ok: false,
      outcome: "partial",
      usersCompleted: 1,
      notificationFailures: 1,
    });
  });

  it("surfaces a declined financial snapshot instead of counting it as complete", async () => {
    const declined = {
      status: "stale",
      authority: "stale",
      currency: "USD",
      reason: "market_price_unavailable",
    };
    mocks.snapshotNetWorth.mockResolvedValue(declined);

    const body = await (await GET(request())).json();

    expect(body).toMatchObject({
      ok: false,
      outcome: "partial",
      snapshotDeclined: 1,
      usersCompleted: 1,
    });
    expect(mocks.writeDailyBrief).toHaveBeenCalledWith(
      expect.anything(),
      USER_ID,
      "person@example.com",
      declined,
      expect.anything(),
    );
    expect(mocks.writeWeeklyRecap).toHaveBeenCalledWith(
      expect.anything(),
      USER_ID,
      "person@example.com",
      null,
      declined,
      expect.anything(),
    );
  });

  it("keeps discovery and auth lookup failures visible in the aggregate outcome", async () => {
    const admin = adminClient({
      users: { data: null, error: new Error("connection discovery failed") },
      holdingUsers: { data: [{ user_id: USER_ID }], error: null },
      authError: new Error("auth unavailable"),
    });
    mocks.createAdminClient.mockReturnValue(admin);

    const body = await (await GET(request())).json();

    expect(body).toMatchObject({
      ok: false,
      outcome: "partial",
      discoveryErrors: 1,
      authLookupFailures: 1,
      usersProcessed: 1,
      usersCompleted: 0,
    });
    expect(mocks.snapshotNetWorth).not.toHaveBeenCalled();
  });

  it("does not swallow a per-user job exception into a successful run", async () => {
    mocks.detectRecurring.mockRejectedValue(new Error("database unavailable"));

    const body = await (await GET(request())).json();

    expect(body).toMatchObject({
      ok: false,
      outcome: "partial",
      usersCompleted: 0,
      userFailures: 1,
    });
  });

  it("marks the run partial when an in-flight user job crosses the wall-clock deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-23T12:00:00.000Z"));
    mocks.snapshotNetWorth.mockImplementation(async () => {
      vi.setSystemTime(new Date("2026-07-23T12:01:00.000Z"));
      return freshSnapshot;
    });

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      ok: false,
      outcome: "partial",
      deadlineExceeded: true,
    });
    expect(mocks.detectRecurring).not.toHaveBeenCalled();
  });

  it("returns a truthful partial outcome when a user job never resolves", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-23T12:00:00.000Z"));
    mocks.snapshotNetWorth.mockImplementation(() => new Promise(() => undefined));

    const pendingResponse = GET(request());
    await vi.advanceTimersByTimeAsync(50_001);
    const response = await pendingResponse;
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      ok: false,
      outcome: "partial",
      usersCompleted: 0,
      userFailures: 1,
      deadlineExceeded: true,
    });
  });
});
