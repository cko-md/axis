import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { plaidAccountAdapter } from "./adapter";

const getPlaidAccessConnectionsMock = vi.hoisted(() => vi.fn());
const admitPlaidRequestMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/fund/plaidTokens", () => ({
  getPlaidAccessConnections: getPlaidAccessConnectionsMock,
}));
vi.mock("./admission", () => ({
  admitPlaidRequest: admitPlaidRequestMock,
}));

const originalFetch = global.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  const value = status >= 200 && status < 300 && body && typeof body === "object"
    ? {
        request_id: "request-1",
        item: { item_id: "item-1" },
        ...(body as Record<string, unknown>),
      }
    : body;
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("plaidAccountAdapter", () => {
  beforeEach(() => {
    vi.stubEnv("PLAID_CLIENT_ID", "client-id");
    vi.stubEnv("PLAID_SECRET", "secret");
    vi.stubEnv("PLAID_ENV", "sandbox");
    getPlaidAccessConnectionsMock.mockResolvedValue([{
      id: "connection-1",
      itemId: "item-1",
      institution: "Bank",
      accessToken: "access-token",
    }]);
    admitPlaidRequestMock.mockResolvedValue("allowed");
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    getPlaidAccessConnectionsMock.mockReset();
    admitPlaidRequestMock.mockReset();
    vi.unstubAllEnvs();
  });

  it("returns not_supported without fetching when Plaid credentials are absent", async () => {
    vi.stubEnv("PLAID_CLIENT_ID", "");
    vi.stubEnv("PLAID_SECRET", "");

    const result = await plaidAccountAdapter.getTransactions("user-1");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({ code: "not_supported", provider: "plaid", retryable: false });
    }
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("returns auth_expired without fetching when the user has no linked token", async () => {
    getPlaidAccessConnectionsMock.mockResolvedValue([]);

    const result = await plaidAccountAdapter.getLiabilities("user-1");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({ code: "auth_expired", provider: "plaid", retryable: false });
    }
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("fetches and normalizes recent transactions behind the Result contract", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(jsonResponse({
      total_transactions: 1,
      transactions: [
        {
          transaction_id: "txn_1",
          name: "Coffee",
          merchant_name: "Blue Bottle",
          amount: 4.25,
          date: "2026-07-14",
          pending: false,
          iso_currency_code: "USD",
        },
      ],
    }));

    const result = await plaidAccountAdapter.getTransactions("user-1", { days: 15 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(1);
      expect(result.data[0]).toMatchObject({
        id: "connection-1:txn_1",
        merchantName: "Blue Bottle",
        amount: -4.25,
        currency: "USD",
        provenance: {
          provider: "plaid",
          connectionId: "connection-1",
          providerRecordId: "txn_1",
          effectiveAt: "2026-07-14",
        },
      });
    }
    const [url, init] = vi.mocked(global.fetch).mock.calls[0];
    expect(url).toBe("https://sandbox.plaid.com/transactions/get");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      client_id: "client-id",
      secret: "secret",
      access_token: "access-token",
      options: { count: 250, offset: 0 },
    });
  });

  it("fetches and normalizes liabilities joined to account summaries", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(jsonResponse({
      accounts: [
        {
          account_id: "acc_credit",
          name: "Credit Card",
          balances: { current: 123.45, iso_currency_code: "USD" },
        },
      ],
      liabilities: {
        credit: [
          {
            account_id: "acc_credit",
            last_payment_amount: 25,
            next_payment_due_date: "2026-08-01",
            is_overdue: false,
          },
        ],
      },
    }));

    const result = await plaidAccountAdapter.getLiabilities("user-1");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(1);
      expect(result.data[0]).toMatchObject({
        accountId: "connection-1:acc_credit",
        type: "credit",
        name: "Credit Card",
        balanceCurrent: 123.45,
        lastPaymentAmount: 25,
        nextPaymentDueDate: "2026-08-01",
        isOverdue: false,
        provenance: {
          provider: "plaid",
          connectionId: "connection-1",
          providerRecordId: "acc_credit",
          currency: "USD",
        },
      });
    }
    expect(vi.mocked(global.fetch).mock.calls[0][0]).toBe("https://sandbox.plaid.com/liabilities/get");
  });

  it("maps upstream and thrown failures to structured integration errors", async () => {
    vi.mocked(global.fetch)
      .mockResolvedValueOnce(jsonResponse({ error_code: "RATE_LIMIT" }, 429))
      .mockRejectedValueOnce(new Error("socket closed"));

    const rateLimited = await plaidAccountAdapter.getTransactions("user-1");
    const network = await plaidAccountAdapter.getLiabilities("user-1");

    expect(rateLimited.ok).toBe(false);
    if (!rateLimited.ok) {
      expect(rateLimited.error).toMatchObject({ code: "rate_limited", provider: "plaid", status: 429, retryable: true });
    }
    expect(network.ok).toBe(false);
    if (!network.ok) {
      expect(network.error).toMatchObject({ code: "network", provider: "plaid", retryable: true });
    }
  });

  it("does not load credentials or call Plaid when distributed admission is unavailable", async () => {
    admitPlaidRequestMock.mockResolvedValueOnce("unavailable");
    const result = await plaidAccountAdapter.getAccounts("user-1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ status: 503, retryable: true });
    expect(getPlaidAccessConnectionsMock).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("rejects provider Item mismatch and missing account currency", async () => {
    vi.mocked(global.fetch)
      .mockResolvedValueOnce(jsonResponse({
        item: { item_id: "another-item" },
        accounts: [],
      }))
      .mockResolvedValueOnce(jsonResponse({
        accounts: [{ account_id: "cash", name: "Cash", balances: { current: 100 } }],
      }));
    const mismatch = await plaidAccountAdapter.getAccounts("user-1");
    const missingCurrency = await plaidAccountAdapter.getAccounts("user-1");
    expect(mismatch.ok).toBe(false);
    expect(missingCurrency.ok).toBe(false);
  });
});
