import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  encrypt: vi.fn(),
  decrypt: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("@/lib/crypto", () => ({ encrypt: mocks.encrypt, decrypt: mocks.decrypt }));
vi.mock("@sentry/nextjs", () => ({ captureException: mocks.captureException }));

import {
  getPlaidAccessConnections,
  PlaidCredentialStoreError,
  savePlaidConnection,
} from "./plaidTokens";

function client(rows: unknown[], error: unknown = null, upsertError: unknown = null) {
  const selectChain: Record<string, unknown> = {};
  for (const method of ["select", "eq", "order", "limit"]) {
    selectChain[method] = vi.fn(() => selectChain);
  }
  selectChain.then = (
    resolve: (value: { data: unknown[]; error: unknown }) => unknown,
    reject: (reason: unknown) => unknown,
  ) => Promise.resolve({ data: rows, error }).then(resolve, reject);
  return {
    from: vi.fn(() => ({
      ...selectChain,
      upsert: vi.fn(async () => ({ error: upsertError })),
    })),
  };
}

describe("Plaid credential-store authority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.decrypt.mockReturnValue("access-token");
    mocks.encrypt.mockReturnValue("ciphertext");
  });

  it("distinguishes a true disconnect from corrupt or duplicate linked rows", async () => {
    mocks.createAdminClient.mockReturnValueOnce(client([]));
    await expect(getPlaidAccessConnections("user")).resolves.toEqual([]);

    mocks.createAdminClient.mockReturnValueOnce(client([{
      id: "connection",
      item_id: "item",
      institution: "Bank",
      access_token_enc: "ciphertext",
    }]));
    mocks.decrypt.mockReturnValueOnce(null);
    await expect(getPlaidAccessConnections("user")).rejects.toBeInstanceOf(PlaidCredentialStoreError);

    mocks.createAdminClient.mockReturnValueOnce(client([
      { id: "one", item_id: "one", institution: null, access_token_enc: "one" },
      { id: "two", item_id: "two", institution: null, access_token_enc: "two" },
    ]));
    await expect(getPlaidAccessConnections("user")).rejects.toBeInstanceOf(PlaidCredentialStoreError);
  });

  it("captures only synthetic safe errors when selects or saves fail", async () => {
    const raw = { message: "ciphertext=secret-token", details: "user@example.com" };
    mocks.createAdminClient.mockReturnValueOnce(client([], raw));
    await expect(getPlaidAccessConnections("user")).rejects.toBeInstanceOf(PlaidCredentialStoreError);
    expect(mocks.captureException).not.toHaveBeenCalledWith(raw, expect.anything());

    mocks.createAdminClient.mockReturnValueOnce(client([], null, raw));
    await expect(savePlaidConnection("user", "token", "item", null)).resolves.toBe(false);
    expect(mocks.captureException).not.toHaveBeenCalledWith(raw, expect.anything());
    expect(JSON.stringify(mocks.captureException.mock.calls)).not.toContain("secret-token");
    expect(JSON.stringify(mocks.captureException.mock.calls)).not.toContain("user@example.com");
  });
});
