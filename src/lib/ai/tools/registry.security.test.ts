import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeTool, TOOLS } from "./registry";

const dependencies = vi.hoisted(() => ({
  admin: vi.fn(),
  decrypt: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => dependencies.admin(),
}));
vi.mock("@/lib/crypto", () => ({
  decrypt: (...args: unknown[]) => dependencies.decrypt(...args),
}));
vi.mock("@/app/api/plaid/_lib", () => ({
  getPlaidCreds: () => ({
    clientId: "client-id",
    secret: "secret",
    env: "sandbox",
  }),
  plaidHost: () => "https://sandbox.plaid.test",
}));

describe("Advisor financial tool input boundaries", () => {
  function cashClient(
    connections: Array<{
      id: string;
      item_id: string | null;
      access_token_enc: string | null;
    }>,
    error: unknown = null,
  ) {
    const limit = vi.fn(async () => ({ data: connections, error }));
    const query = {
      eq: vi.fn(() => query),
      not: vi.fn(() => query),
      limit,
    };
    const from = vi.fn(() => ({ select: vi.fn(() => query) }));
    dependencies.admin.mockReturnValue({ from });
    return {
      from,
      limit,
      supabase: { from } as unknown as SupabaseClient,
    };
  }

  function plaidResponse(
    {
      balance = 100,
      currency = "USD",
      accounts = 1,
      subtype = "checking",
      persistentId = "persistent-account-1",
      itemId = "item-1",
    }: {
      balance?: number;
      currency?: string;
      accounts?: number;
      subtype?: string;
      persistentId?: string | null;
      itemId?: string;
    } = {},
  ) {
    return {
      ok: true,
      json: async () => ({
        item: { item_id: itemId },
        accounts: Array.from({ length: accounts }, (_, index) => ({
          account_id: `provider-account-${index + 1}`,
          persistent_account_id: persistentId,
          name: `Checking ${index + 1}`,
          mask: "1234",
          type: "depository",
          subtype,
          balances: {
            available: balance,
            current: balance + 25,
            iso_currency_code: currency,
            unofficial_currency_code: null,
          },
        })),
      }),
    };
  }

  beforeEach(() => {
    dependencies.admin.mockReset();
    dependencies.decrypt.mockReset();
    dependencies.decrypt.mockImplementation(
      (value: string) => `token:${value}`,
    );
  });

  it("refuses a multi-Item relink that could double-count the same real account", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(plaidResponse({
        itemId: "item-original",
        persistentId: "same-real-account",
      }))
      .mockResolvedValueOnce(plaidResponse({
        itemId: "item-relink",
        persistentId: "same-real-account",
      }));
    vi.stubGlobal("fetch", fetchMock);
    const { supabase } = cashClient([
      {
        id: "connection-1",
        item_id: "item-original",
        access_token_enc: "encrypted-1",
      },
      {
        id: "connection-2",
        item_id: "item-relink",
        access_token_enc: "encrypted-2",
      },
    ]);

    await expect(executeTool(
      "get_cash_accounts",
      {},
      { supabase, userId: "user-1" },
    )).rejects.toMatchObject({ code: "DATA_UNAVAILABLE" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refuses multi-Item aggregation when persistent identity proof is absent", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(plaidResponse({
        itemId: "item-one",
        persistentId: null,
      }))
      .mockResolvedValueOnce(plaidResponse({
        itemId: "item-two",
        persistentId: null,
      }));
    vi.stubGlobal("fetch", fetchMock);
    const { supabase } = cashClient([
      {
        id: "connection-1",
        item_id: "item-one",
        access_token_enc: "encrypted-1",
      },
      {
        id: "connection-2",
        item_id: "item-two",
        access_token_enc: "encrypted-2",
      },
    ]);

    await expect(executeTool(
      "get_cash_accounts",
      {},
      { supabase, userId: "user-1" },
    )).rejects.toMatchObject({ code: "DATA_UNAVAILABLE" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches one unambiguous Item with timeout and complete USD provenance", async () => {
    const fetchMock = vi.fn().mockResolvedValue(plaidResponse());
    vi.stubGlobal("fetch", fetchMock);
    const { supabase, limit } = cashClient([
      {
        id: "connection-1",
        item_id: "item-1",
        access_token_enc: "encrypted-1",
      },
    ]);

    const result = await executeTool(
      "get_cash_accounts",
      {},
      { supabase, userId: "user-1" },
    );

    expect(limit).toHaveBeenCalledWith(9);
    expect(fetchMock).toHaveBeenCalledOnce();
    for (const [, init] of fetchMock.mock.calls) {
      expect(init).toEqual(expect.objectContaining({
        signal: expect.any(AbortSignal),
      }));
    }
    expect(result).toEqual(expect.objectContaining({
      total_cash: 100,
      currency: "USD",
      source: "plaid_live",
      retrieved_at: expect.any(String),
      coverage: {
        connections_expected: 1,
        connections_succeeded: 1,
        complete: true,
      },
    }));
    expect(result).toEqual(expect.objectContaining({
      accounts: expect.arrayContaining([
        expect.objectContaining({
          connection_id: "connection-1",
          item_id: "item-1",
          provider_account_id: "provider-account-1",
          persistent_account_id: "persistent-account-1",
          balance: 100,
          balance_basis: "available",
          currency: "USD",
          source: "plaid_live",
          retrieved_at: expect.any(String),
        }),
      ]),
    }));
  });

  it("counts only depository available balances from a mixed Plaid response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        item: { item_id: "item-1" },
        accounts: [
          {
            account_id: "provider-checking",
            persistent_account_id: "persistent-checking",
            name: "Checking",
            mask: "1111",
            type: "depository",
            subtype: "checking",
            balances: {
              available: 75,
              current: 125,
              iso_currency_code: "USD",
              unofficial_currency_code: null,
            },
          },
          ...["credit", "loan", "investment"].map((type) => ({
            account_id: `provider-${type}`,
            persistent_account_id: `persistent-${type}`,
            name: `${type} account`,
            mask: "9999",
            type,
            subtype: type,
            balances: {
              available: 10_000,
              current: 10_000,
              iso_currency_code: "USD",
              unofficial_currency_code: null,
            },
          })),
        ],
      }),
    }));
    const { supabase } = cashClient([
      {
        id: "connection-1",
        item_id: "item-1",
        access_token_enc: "encrypted-1",
      },
    ]);

    const result = await executeTool(
      "get_cash_accounts",
      {},
      { supabase, userId: "user-1" },
    ) as { accounts: Array<{ type: string; balance: number }>; total_cash: number };

    expect(result.total_cash).toBe(75);
    expect(result.accounts).toEqual([
      expect.objectContaining({
        name: "Checking",
        type: "depository",
        balance: 75,
      }),
    ]);
  });

  it("rejects a live Plaid Item identity that does not match the local locator", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(plaidResponse({
      itemId: "different-item",
    })));
    const { supabase } = cashClient([
      {
        id: "connection-1",
        item_id: "expected-item",
        access_token_enc: "encrypted-1",
      },
    ]);

    await expect(executeTool(
      "get_cash_accounts",
      {},
      { supabase, userId: "user-1" },
    )).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });

  it.each([
    ["no verified connections", []],
    ["too many verified connections", Array.from(
      { length: 9 },
      (_, index) => ({
        id: `connection-${index}`,
        item_id: `item-${index}`,
        access_token_enc: `encrypted-${index}`,
      }),
    )],
  ])("fails closed for %s without provider dispatch", async (
    _case,
    connections,
  ) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { supabase } = cashClient(connections);

    await expect(executeTool(
      "get_cash_accounts",
      {},
      { supabase, userId: "user-1" },
    )).rejects.toMatchObject({ code: "DATA_UNAVAILABLE" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["non-USD account", plaidResponse({ currency: "EUR" })],
    ["empty account coverage", plaidResponse({ accounts: 0 })],
    ["unproved depository subtype", plaidResponse({ subtype: "cash management" })],
    ["non-canonical available balance", plaidResponse({ balance: 0.001 })],
  ])("rejects %s rather than returning partial or fabricated cash", async (
    _case,
    providerResponse,
  ) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(providerResponse));
    const { supabase } = cashClient([
      {
        id: "connection-1",
        item_id: "item-1",
        access_token_enc: "encrypted-1",
      },
    ]);

    await expect(executeTool(
      "get_cash_accounts",
      {},
      { supabase, userId: "user-1" },
    )).rejects.toMatchObject({ code: "DATA_UNAVAILABLE" });
  });

  it("fails the whole cash read when any connection fetch fails", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(plaidResponse())
      .mockRejectedValueOnce(new Error("timeout"));
    vi.stubGlobal("fetch", fetchMock);
    const { supabase } = cashClient([
      {
        id: "connection-1",
        item_id: "item-1",
        access_token_enc: "encrypted-1",
      },
      {
        id: "connection-2",
        item_id: "item-2",
        access_token_enc: "encrypted-2",
      },
    ]);

    await expect(executeTool(
      "get_cash_accounts",
      {},
      { supabase, userId: "user-1" },
    )).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(
      ([, init]) => (init as RequestInit).signal?.aborted,
    )).toBe(true);
  });

  it("fails before provider dispatch when a linked token cannot be decrypted", async () => {
    dependencies.decrypt.mockReturnValueOnce(null);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { supabase } = cashClient([
      {
        id: "connection-1",
        item_id: "item-1",
        access_token_enc: "unreadable",
      },
    ]);

    await expect(executeTool(
      "get_cash_accounts",
      {},
      { supabase, userId: "user-1" },
    )).rejects.toMatchObject({ code: "DATA_UNAVAILABLE" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails before provider dispatch when the local Item locator is missing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { supabase } = cashClient([
      {
        id: "connection-1",
        item_id: null,
        access_token_enc: "encrypted-1",
      },
    ]);

    await expect(executeTool(
      "get_cash_accounts",
      {},
      { supabase, userId: "user-1" },
    )).rejects.toMatchObject({ code: "DATA_UNAVAILABLE" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not assume zero when the connection lookup fails", async () => {
    const { supabase } = cashClient([], { code: "DB_DOWN" });

    await expect(executeTool(
      "get_cash_accounts",
      {},
      { supabase, userId: "user-1" },
    )).rejects.toMatchObject({ code: "DATA_UNAVAILABLE" });
  });

  it("does not query the user-scoped client when the trusted store is unavailable", async () => {
    const userFrom = vi.fn();
    dependencies.admin.mockReturnValue(null);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const supabase = { from: userFrom } as unknown as SupabaseClient;

    await expect(executeTool(
      "get_cash_accounts",
      {},
      { supabase, userId: "user-1" },
    )).rejects.toMatchObject({ code: "DATA_UNAVAILABLE" });
    expect(userFrom).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["negative", -1],
    ["negative extreme", -1_000_000_000_000_000],
    ["negative zero", -0],
    ["too large", 1_000_000_001],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["not a number", Number.NaN],
    ["numeric string", "100"],
    ["scientific string", "1e3"],
    ["excess decimal precision", 0.001],
  ])("rejects a %s safety buffer before reading financial data", async (
    _case,
    buffer,
  ) => {
    const from = vi.fn();
    const supabase = { from } as unknown as SupabaseClient;

    await expect(executeTool(
      "compute_safe_to_invest",
      { buffer },
      { supabase, userId: "user-1" },
    )).rejects.toMatchObject({
      name: "ToolExecutionError",
      code: "INVALID_INPUT",
    });
    expect(from).not.toHaveBeenCalled();
  });

  it.each([
    ["zero", 0],
    ["two-decimal money", 123.45],
    ["maximum", 1_000_000_000],
  ])("accepts canonical %s buffer input but disables unsupported cross-source calculation", async (
    _case,
    buffer,
  ) => {
    const from = vi.fn();
    const supabase = { from } as unknown as SupabaseClient;

    await expect(executeTool(
      "compute_safe_to_invest",
      { buffer },
      { supabase, userId: "user-1" },
    )).rejects.toMatchObject({
      name: "ToolExecutionError",
      code: "DATA_UNAVAILABLE",
    });
    expect(from).not.toHaveBeenCalled();
  });

  it("publishes the same non-negative server bound to the model tool schema", () => {
    const tool = TOOLS.find(({ name }) => name === "compute_safe_to_invest");

    expect(tool?.input_schema.properties.buffer).toEqual(expect.objectContaining({
      type: "number",
      minimum: 0,
      maximum: 1_000_000_000,
    }));
  });
});
