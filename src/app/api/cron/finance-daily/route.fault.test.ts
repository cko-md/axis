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
  captureException: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: mocks.captureException,
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
  for (const method of ["select", "eq", "limit", "order", "gt", "lt"]) chain[method] = vi.fn(() => chain);
  chain.maybeSingle = vi.fn(async () => result);
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
  lease?: QueryResult;
} = {}) {
  let connectionReads = 0;
  const from = vi.fn((table: string) => {
    if (table === "finance_cron_cursors") {
      return {
        ...query({ data: null, error: null }),
        upsert: vi.fn(async () => ({ error: null })),
      };
    }
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
  const rpc = vi.fn(async (name: string) => {
    if (name === "acquire_finance_cron_run") {
      return options.lease ?? { data: true, error: null };
    }
    if (name === "claim_finance_cron_connections") {
      return options.connections ?? {
        data: [{ id: "connection-1", user_id: USER_ID, access_token_enc: "encrypted" }],
        error: null,
      };
    }
    if (name === "claim_finance_cron_users") {
      return options.users ?? { data: [{ user_id: USER_ID }], error: null };
    }
    if (name === "fail_finance_cron_item") {
      return { data: "retry_scheduled", error: null };
    }
    if (name === "ack_finance_cron_connection" || name === "ack_finance_cron_user" || name === "release_finance_cron_run") {
      return { data: true, error: null };
    }
    throw new Error(`Unexpected RPC ${name}`);
  });
  return {
    from,
    rpc,
    auth: {
      admin: {
        getUserById: vi.fn(async (userId: string) => {
          void userId;
          return options.authError
            ? { data: null, error: options.authError }
            : { data: { user: { id: USER_ID, email: "person@example.com" } }, error: null };
        }),
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
      authLookupFailures: 0,
      usersProcessed: 0,
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

  it("captures operational sync failures using only the normalized safe code", async () => {
    mocks.syncPlaidTransactions.mockResolvedValue({ error: "PLAID_TXN_FETCH_FAILED" });

    const response = await GET(request());

    expect(response.status).toBe(503);
    expect(mocks.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Finance daily Plaid sync failed" }),
      { tags: { area: "fund", stage: "sync", code: "PLAID_TXN_FETCH_FAILED" } },
    );
  });

  it("backs off an item-local Plaid deadline and continues into the user phase", async () => {
    const admin = adminClient();
    admin.rpc.mockImplementation(async (name: string) => {
      if (name === "acquire_finance_cron_run" || name === "ack_finance_cron_connection" || name === "ack_finance_cron_user" || name === "release_finance_cron_run") {
        return { data: true, error: null };
      }
      if (name === "fail_finance_cron_item") return { data: "retry_scheduled", error: null };
      if (name === "claim_finance_cron_connections") {
        return { data: [
          { id: "connection-slow", user_id: USER_ID, access_token_enc: "encrypted" },
          { id: "connection-later", user_id: USER_ID, access_token_enc: "encrypted" },
        ], error: null };
      }
      if (name === "claim_finance_cron_users") return { data: [{ user_id: USER_ID }], error: null };
      throw new Error(`Unexpected RPC ${name}`);
    });
    mocks.createAdminClient.mockReturnValue(admin);
    mocks.syncPlaidTransactions
      .mockResolvedValueOnce({ error: "PLAID_TXN_DEADLINE_EXCEEDED" })
      .mockResolvedValueOnce({ synced: 1 });

    const response = await GET(request());

    expect(response.status).toBe(503);
    expect(admin.rpc).toHaveBeenCalledWith("fail_finance_cron_item", expect.objectContaining({
      p_phase: "connections",
      p_item_id: "connection-slow",
      p_error_code: "PLAID_TXN_DEADLINE_EXCEEDED",
    }));
    expect(admin.rpc).toHaveBeenCalledWith("ack_finance_cron_connection", expect.objectContaining({ p_connection_id: "connection-later" }));
    expect(admin.rpc).toHaveBeenCalledWith("ack_finance_cron_user", expect.objectContaining({ p_user_id: USER_ID }));
    expect(mocks.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Finance daily Plaid sync failed" }),
      { tags: { area: "fund", stage: "sync", code: "PLAID_TXN_DEADLINE_EXCEEDED" } },
    );
  });

  it("does not consume a failure attempt when the parent route deadline is exhausted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-09T12:00:00.000Z"));
    const admin = adminClient();
    mocks.createAdminClient.mockReturnValue(admin);
    mocks.syncPlaidTransactions.mockImplementation(async () => {
      vi.setSystemTime(new Date("2026-08-09T12:01:00.000Z"));
      return { error: "PLAID_TXN_DEADLINE_EXCEEDED" };
    });

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({ deadlineExceeded: true });
    expect(admin.rpc).not.toHaveBeenCalledWith("fail_finance_cron_item", expect.anything());
    expect(admin.rpc).not.toHaveBeenCalledWith("claim_finance_cron_users", expect.anything());
  });

  it("retains the lease and stops when a connection does not settle after cancellation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-09T12:00:00.000Z"));
    const admin = adminClient();
    admin.rpc.mockImplementation(async (name: string) => {
      if (name === "acquire_finance_cron_run") return { data: true, error: null };
      if (name === "claim_finance_cron_connections") {
        return { data: [
          { id: "connection-hung", user_id: USER_ID, access_token_enc: "encrypted" },
          { id: "connection-later", user_id: USER_ID, access_token_enc: "encrypted" },
        ], error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    });
    mocks.createAdminClient.mockReturnValue(admin);
    mocks.syncPlaidTransactions.mockImplementation(() => new Promise(() => undefined));

    const pendingResponse = GET(request());
    await vi.advanceTimersByTimeAsync(22_001);
    const response = await pendingResponse;
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({ cancellationUnconfirmed: true, usersProcessed: 0 });
    expect(mocks.syncPlaidTransactions).toHaveBeenCalledTimes(1);
    expect(admin.rpc).not.toHaveBeenCalledWith("fail_finance_cron_item", expect.anything());
    expect(admin.rpc).not.toHaveBeenCalledWith("claim_finance_cron_users", expect.anything());
    expect(admin.rpc).not.toHaveBeenCalledWith("release_finance_cron_run", expect.anything());
  });

  it("reserves user capacity when slow connections exhaust the connection phase", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-09T12:00:00.000Z"));
    const admin = adminClient();
    admin.rpc.mockImplementation(async (name: string) => {
      if (name === "acquire_finance_cron_run" || name === "ack_finance_cron_user" || name === "release_finance_cron_run") {
        return { data: true, error: null };
      }
      if (name === "fail_finance_cron_item") return { data: "retry_scheduled", error: null };
      if (name === "claim_finance_cron_connections") {
        return { data: [
          { id: "connection-slow-one", user_id: USER_ID, access_token_enc: "encrypted" },
          { id: "connection-slow-two", user_id: USER_ID, access_token_enc: "encrypted" },
        ], error: null };
      }
      if (name === "claim_finance_cron_users") return { data: [{ user_id: USER_ID }], error: null };
      throw new Error(`Unexpected RPC ${name}`);
    });
    mocks.createAdminClient.mockReturnValue(admin);
    mocks.syncPlaidTransactions.mockImplementation((_admin, _userId, _connectionId, _token, signal: AbortSignal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      }));

    const pendingResponse = GET(request());
    await vi.advanceTimersByTimeAsync(20_001);
    await vi.advanceTimersByTimeAsync(5_001);
    const response = await pendingResponse;
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({ connectionPhaseDeferred: true, usersCompleted: 1, deadlineExceeded: false });
    expect(admin.rpc).toHaveBeenCalledWith("fail_finance_cron_item", expect.objectContaining({
      p_item_id: "connection-slow-one",
      p_error_code: "PLAID_TXN_DEADLINE_EXCEEDED",
    }));
    expect(admin.rpc).not.toHaveBeenCalledWith("fail_finance_cron_item", expect.objectContaining({ p_item_id: "connection-slow-two" }));
    expect(admin.rpc).toHaveBeenCalledWith("ack_finance_cron_user", expect.objectContaining({ p_user_id: USER_ID }));
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

  it("waits for an aborted user job to settle before returning the partial outcome", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-23T12:00:00.000Z"));
    let aborted = false;
    mocks.snapshotNetWorth.mockImplementation((_admin, _userId, signal: AbortSignal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      }));

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
      deadlineExceeded: false,
    });
    expect(aborted).toBe(true);
  });

  it("returns a truthful deadline outcome when an operation never settles", async () => {
    const admin = adminClient();
    mocks.createAdminClient.mockReturnValue(admin);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-23T12:00:00.000Z"));
    mocks.snapshotNetWorth.mockImplementation(() => new Promise(() => undefined));

    const pendingResponse = GET(request());
    await vi.advanceTimersByTimeAsync(52_001);
    const response = await pendingResponse;
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      ok: false,
      outcome: "partial",
      usersCompleted: 0,
      userFailures: 1,
      deadlineExceeded: false,
      cancellationUnconfirmed: true,
    });
    expect(mocks.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Finance daily job did not settle after cancellation" }),
      { tags: { area: "fund", stage: "deadline", code: "ABORT_SETTLEMENT_EXCEEDED" } },
    );
    expect(admin.rpc).not.toHaveBeenCalledWith("fail_finance_cron_item", expect.anything());
    expect(admin.rpc).not.toHaveBeenCalledWith("release_finance_cron_run", expect.anything());
  });

  it("visits the 101st connection on the next durable claim instead of starving it", async () => {
    const connections = Array.from({ length: 101 }, (_, index) => ({
      id: `connection-${String(index + 1).padStart(3, "0")}`,
      user_id: USER_ID,
      access_token_enc: "encrypted",
    }));
    let claimCount = 0;
    const admin = adminClient({ users: { data: [], error: null } });
    admin.rpc.mockImplementation(async (name: string) => {
      if (name === "acquire_finance_cron_run" || name === "ack_finance_cron_connection" || name === "release_finance_cron_run") {
        return { data: true, error: null };
      }
      if (name === "claim_finance_cron_users") return { data: [], error: null };
      if (name === "claim_finance_cron_connections") {
        const claimed = claimCount++ === 0 ? connections.slice(0, 100) : connections.slice(100);
        return { data: claimed, error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    });
    mocks.createAdminClient.mockReturnValue(admin);

    expect((await GET(request())).status).toBe(200);
    expect(mocks.syncPlaidTransactions).not.toHaveBeenCalledWith(
      expect.anything(), expect.anything(), "connection-101", expect.anything(), expect.anything(),
    );
    mocks.syncPlaidTransactions.mockClear();

    expect((await GET(request())).status).toBe(200);
    expect(mocks.syncPlaidTransactions).toHaveBeenCalledWith(
      expect.anything(), USER_ID, "connection-101", "provider-token", expect.any(AbortSignal),
    );
  });

  it("returns busy without claiming work when another durable run owns the lease", async () => {
    const admin = adminClient({ lease: { data: false, error: null } });
    mocks.createAdminClient.mockReturnValue(admin);

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      outcome: "busy",
      reason: "FINANCE_CRON_ALREADY_RUNNING",
    });
    expect(admin.rpc).not.toHaveBeenCalledWith("claim_finance_cron_connections", expect.anything());
    expect(mocks.syncPlaidTransactions).not.toHaveBeenCalled();
  });

  it("counts delayed lease acquisition against the absolute route deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-09T12:00:00.000Z"));
    const admin = adminClient();
    admin.rpc.mockImplementation(async (name: string) => {
      if (name === "acquire_finance_cron_run") {
        vi.setSystemTime(new Date("2026-08-09T12:01:00.000Z"));
        return { data: true, error: null };
      }
      if (name === "release_finance_cron_run") return { data: true, error: null };
      throw new Error(`Unexpected RPC ${name}`);
    });
    mocks.createAdminClient.mockReturnValue(admin);

    const response = await GET(request());

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      outcome: "partial",
      error: "FINANCE_CRON_DEADLINE_EXCEEDED",
      deadlineExceeded: true,
    });
    expect(admin.rpc).not.toHaveBeenCalledWith("claim_finance_cron_connections", expect.anything());
    expect(admin.rpc).toHaveBeenCalledWith("release_finance_cron_run", expect.anything());
  });

  it("stops before later work when lease-bound acknowledgement is rejected", async () => {
    const admin = adminClient({ users: { data: [{ user_id: USER_ID }], error: null } });
    admin.rpc.mockImplementation(async (name: string) => {
      if (name === "acquire_finance_cron_run" || name === "release_finance_cron_run") return { data: true, error: null };
      if (name === "claim_finance_cron_connections") {
        return { data: [
          { id: "connection-one", user_id: USER_ID, access_token_enc: "encrypted" },
          { id: "connection-two", user_id: USER_ID, access_token_enc: "encrypted" },
        ], error: null };
      }
      if (name === "ack_finance_cron_connection") return { data: false, error: null };
      throw new Error(`Unexpected RPC ${name}`);
    });
    mocks.createAdminClient.mockReturnValue(admin);

    const response = await GET(request());

    expect(response.status).toBe(503);
    expect(mocks.syncPlaidTransactions).toHaveBeenCalledTimes(1);
    expect(admin.rpc).not.toHaveBeenCalledWith("claim_finance_cron_users", expect.anything());
  });

  it("persists failed connection work, continues later connections, and still runs the user phase", async () => {
    const admin = adminClient({ users: { data: [], error: null } });
    admin.rpc.mockImplementation(async (name: string, args?: Record<string, unknown>) => {
      if (name === "acquire_finance_cron_run" || name === "ack_finance_cron_connection" || name === "ack_finance_cron_user" || name === "release_finance_cron_run") {
        return { data: true, error: null };
      }
      if (name === "fail_finance_cron_item") return { data: "retry_scheduled", error: null };
      if (name === "claim_finance_cron_connections") {
        return {
          data: [
            { id: "connection-poison", user_id: USER_ID, access_token_enc: "poison" },
            { id: "connection-good", user_id: USER_ID, access_token_enc: "good" },
          ],
          error: null,
        };
      }
      if (name === "claim_finance_cron_users") return { data: [{ user_id: USER_ID }], error: null };
      throw new Error(`Unexpected RPC ${name} ${JSON.stringify(args)}`);
    });
    mocks.createAdminClient.mockReturnValue(admin);
    mocks.decrypt.mockImplementation((value: string) => value === "poison" ? "poison-token" : "good-token");
    mocks.syncPlaidTransactions.mockImplementation(async (_admin, _userId, connectionId: string) =>
      connectionId === "connection-poison" ? { error: "PLAID_TXN_FETCH_FAILED" } : { synced: 1 });

    expect((await GET(request())).status).toBe(503);
    expect(admin.rpc).toHaveBeenCalledWith("fail_finance_cron_item", expect.objectContaining({
      p_phase: "connections",
      p_item_id: "connection-poison",
      p_error_code: "PLAID_TXN_FETCH_FAILED",
    }));
    expect(admin.rpc).toHaveBeenCalledWith("ack_finance_cron_connection", expect.objectContaining({ p_connection_id: "connection-good" }));
    expect(admin.rpc).toHaveBeenCalledWith("claim_finance_cron_users", expect.anything());
    expect(admin.rpc).toHaveBeenCalledWith("ack_finance_cron_user", expect.objectContaining({ p_user_id: USER_ID }));
    expect(admin.rpc).toHaveBeenCalledWith("release_finance_cron_run", expect.objectContaining({ p_run_id: expect.any(String) }));
  });

  it("isolates a poison user and completes the later user in the same run", async () => {
    const poisonUser = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
    const goodUser = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
    const admin = adminClient({ connections: { data: [], error: null } });
    admin.rpc.mockImplementation(async (name: string) => {
      if (name === "acquire_finance_cron_run" || name === "ack_finance_cron_user" || name === "release_finance_cron_run") {
        return { data: true, error: null };
      }
      if (name === "fail_finance_cron_item") return { data: "retry_scheduled", error: null };
      if (name === "claim_finance_cron_connections") return { data: [], error: null };
      if (name === "claim_finance_cron_users") {
        return { data: [{ user_id: poisonUser }, { user_id: goodUser }], error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    });
    admin.auth.admin.getUserById.mockImplementation(async (userId: string) =>
      userId === poisonUser
        ? { data: null, error: new Error("synthetic auth failure") }
        : { data: { user: { id: goodUser, email: "good@example.invalid" } }, error: null });
    mocks.createAdminClient.mockReturnValue(admin);

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({ usersProcessed: 2, usersCompleted: 1, userFailures: 1, authLookupFailures: 1 });
    expect(admin.rpc).toHaveBeenCalledWith("fail_finance_cron_item", expect.objectContaining({
      p_phase: "users",
      p_item_id: poisonUser,
      p_error_code: "AUTH_USER_LOOKUP_FAILED",
    }));
    expect(admin.rpc).toHaveBeenCalledWith("ack_finance_cron_user", expect.objectContaining({ p_user_id: goodUser }));
    expect(mocks.snapshotNetWorth).toHaveBeenCalledWith(expect.anything(), goodUser, expect.any(AbortSignal));
  });

  it("backs off a hanging user at its item deadline and completes the later user", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-09T12:00:00.000Z"));
    const slowUser = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
    const laterUser = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
    const admin = adminClient({ connections: { data: [], error: null } });
    admin.rpc.mockImplementation(async (name: string) => {
      if (name === "acquire_finance_cron_run" || name === "ack_finance_cron_user" || name === "release_finance_cron_run") {
        return { data: true, error: null };
      }
      if (name === "fail_finance_cron_item") return { data: "retry_scheduled", error: null };
      if (name === "claim_finance_cron_connections") return { data: [], error: null };
      if (name === "claim_finance_cron_users") {
        return { data: [{ user_id: slowUser }, { user_id: laterUser }], error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    });
    admin.auth.admin.getUserById.mockImplementation(async (userId: string) => ({
      data: { user: { id: userId, email: `${userId.slice(-1)}@example.invalid` } },
      error: null,
    }));
    mocks.createAdminClient.mockReturnValue(admin);
    mocks.snapshotNetWorth.mockImplementation((_admin, userId: string, signal: AbortSignal) => {
      if (userId === laterUser) return Promise.resolve(freshSnapshot);
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    });

    const pendingResponse = GET(request());
    await vi.advanceTimersByTimeAsync(20_001);
    const response = await pendingResponse;
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      usersProcessed: 2,
      usersCompleted: 1,
      userFailures: 1,
      deadlineExceeded: false,
    });
    expect(admin.rpc).toHaveBeenCalledWith("fail_finance_cron_item", expect.objectContaining({
      p_phase: "users",
      p_item_id: slowUser,
      p_error_code: "USER_JOB_DEADLINE_EXCEEDED",
    }));
    expect(admin.rpc).toHaveBeenCalledWith("ack_finance_cron_user", expect.objectContaining({ p_user_id: laterUser }));
  });

  it("bounds a hanging read-only auth lookup and completes the later user", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-09T12:00:00.000Z"));
    const slowUser = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
    const laterUser = "cccccccc-cccc-4ccc-8ccc-ccccccccccc2";
    const admin = adminClient({ connections: { data: [], error: null } });
    admin.rpc.mockImplementation(async (name: string) => {
      if (name === "acquire_finance_cron_run" || name === "ack_finance_cron_user" || name === "release_finance_cron_run") {
        return { data: true, error: null };
      }
      if (name === "fail_finance_cron_item") return { data: "retry_scheduled", error: null };
      if (name === "claim_finance_cron_connections") return { data: [], error: null };
      if (name === "claim_finance_cron_users") {
        return { data: [{ user_id: slowUser }, { user_id: laterUser }], error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    });
    admin.auth.admin.getUserById.mockImplementation((userId: string) =>
      userId === slowUser
        ? new Promise(() => undefined)
        : Promise.resolve({
          data: { user: { id: laterUser, email: "later@example.invalid" } },
          error: null,
        }));
    mocks.createAdminClient.mockReturnValue(admin);

    const pendingResponse = GET(request());
    await vi.advanceTimersByTimeAsync(22_001);
    const response = await pendingResponse;
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({ usersProcessed: 2, usersCompleted: 1, authLookupFailures: 1 });
    expect(admin.rpc).toHaveBeenCalledWith("fail_finance_cron_item", expect.objectContaining({
      p_phase: "users",
      p_item_id: slowUser,
      p_error_code: "AUTH_USER_LOOKUP_DEADLINE_EXCEEDED",
    }));
    expect(admin.rpc).toHaveBeenCalledWith("ack_finance_cron_user", expect.objectContaining({ p_user_id: laterUser }));
    expect(admin.rpc).toHaveBeenCalledWith("release_finance_cron_run", expect.anything());
  });
});
