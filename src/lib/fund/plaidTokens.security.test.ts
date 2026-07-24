import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getPlaidAccessToken,
  PlaidConnectionStoreUnavailableError,
  revokePlaidConnection,
  savePlaidConnection,
} from "./plaidTokens";

const dependencies = vi.hoisted(() => ({
  admin: vi.fn(),
  captureException: vi.fn(),
  decrypt: vi.fn(),
  encrypt: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => dependencies.admin(),
}));
vi.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => dependencies.captureException(...args),
}));
vi.mock("@/lib/crypto", () => ({
  decrypt: (...args: unknown[]) => dependencies.decrypt(...args),
  encrypt: (...args: unknown[]) => dependencies.encrypt(...args),
}));

describe("Plaid server-only connection store", () => {
  function tokenAdmin(
    data: { access_token_enc: unknown } | null,
    error: unknown = null,
  ) {
    const maybeSingle = vi.fn(async () => ({ data, error }));
    const query = {
      eq: vi.fn(() => query),
      not: vi.fn(() => query),
      order: vi.fn(() => query),
      limit: vi.fn(() => query),
      maybeSingle,
    };
    const select = vi.fn(() => query);
    const from = vi.fn(() => ({ select }));
    return { from, query, select };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    dependencies.decrypt.mockReturnValue("plain-token");
    dependencies.encrypt.mockReturnValue("ciphertext");
  });

  it("fails observably without a service-role client", async () => {
    dependencies.admin.mockReturnValue(null);

    await expect(getPlaidAccessToken("user-1")).rejects.toBeInstanceOf(
      PlaidConnectionStoreUnavailableError,
    );
    expect(dependencies.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({
          operation: "load_token",
          code: "service_role_unavailable",
        }),
      }),
    );
  });

  it("contains a thrown service-role client construction failure", async () => {
    dependencies.admin.mockImplementation(() => {
      throw new Error("private configuration detail");
    });

    await expect(getPlaidAccessToken("user-1")).rejects.toBeInstanceOf(
      PlaidConnectionStoreUnavailableError,
    );
    expect(JSON.stringify(dependencies.captureException.mock.calls)).not
      .toContain("private configuration detail");
  });

  it("loads a token only through an explicit owner-scoped admin query", async () => {
    const admin = tokenAdmin({ access_token_enc: "ciphertext" });
    dependencies.admin.mockReturnValue(admin);

    await expect(getPlaidAccessToken("user-1")).resolves.toBe("plain-token");
    expect(admin.from).toHaveBeenCalledWith("fund_connections");
    expect(admin.select).toHaveBeenCalledWith("access_token_enc");
    expect(admin.query.eq).toHaveBeenNthCalledWith(1, "user_id", "user-1");
    expect(admin.query.eq).toHaveBeenNthCalledWith(2, "provider", "plaid");
    expect(admin.query.eq).toHaveBeenNthCalledWith(3, "status", "linked");
    expect(admin.query.eq).toHaveBeenNthCalledWith(
      4,
      "authority",
      "provider_verified",
    );
    expect(admin.query.not).toHaveBeenCalledWith("verified_at", "is", null);
  });

  it("returns null only for a genuinely absent linked row", async () => {
    dependencies.admin.mockReturnValue(tokenAdmin(null));

    await expect(getPlaidAccessToken("user-1")).resolves.toBeNull();
    expect(dependencies.captureException).not.toHaveBeenCalled();
  });

  it.each([
    ["null", null, null],
    ["empty", "", null],
    ["wrong type", 42, null],
    ["corrupt", "ciphertext", null],
    ["throwing decrypt", "ciphertext", new Error("private crypto detail")],
  ])("treats %s ciphertext as observable store corruption", async (
    _case,
    ciphertext,
    decryptFailure,
  ) => {
    dependencies.admin.mockReturnValue(
      tokenAdmin({ access_token_enc: ciphertext }),
    );
    if (decryptFailure) {
      dependencies.decrypt.mockImplementation(() => {
        throw decryptFailure;
      });
    } else {
      dependencies.decrypt.mockReturnValue(null);
    }

    await expect(getPlaidAccessToken("user-1")).rejects.toBeInstanceOf(
      PlaidConnectionStoreUnavailableError,
    );
    expect(dependencies.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ code: "decryption_failed" }),
      }),
    );
    expect(JSON.stringify(dependencies.captureException.mock.calls)).not
      .toContain("private crypto detail");
  });

  it("does not send raw database failure details to observability", async () => {
    dependencies.admin.mockReturnValue(
      tokenAdmin(null, {
        code: "DB_DOWN",
        message: "ciphertext=private-secret item=item-private",
      }),
    );

    await expect(getPlaidAccessToken("user-1")).rejects.toBeInstanceOf(
      PlaidConnectionStoreUnavailableError,
    );
    expect(JSON.stringify(dependencies.captureException.mock.calls)).not
      .toContain("private-secret");
  });

  it("persists provider authority through admin with the authenticated owner id", async () => {
    const upsert = vi.fn(async () => ({ error: null }));
    dependencies.admin.mockReturnValue({
      from: vi.fn(() => ({ upsert })),
    });

    await expect(savePlaidConnection(
      "user-1",
      "provider-token",
      "item-1",
      "Owner Bank",
    )).resolves.toBe(true);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: "user-1",
        provider: "plaid",
        item_id: "item-1",
        status: "linked",
        authority: "provider_verified",
        verified_at: expect.any(String),
        access_token_enc: "ciphertext",
      }),
      { onConflict: "user_id,provider,item_id" },
    );
  });

  it("normalizes thrown encryption without exposing token material", async () => {
    dependencies.encrypt.mockImplementation(() => {
      throw new Error("provider-token private detail");
    });
    dependencies.admin.mockReturnValue({
      from: vi.fn(),
    });

    await expect(savePlaidConnection(
      "user-1",
      "provider-token",
      "item-1",
      "Owner Bank",
    )).resolves.toBe(false);
    expect(JSON.stringify(dependencies.captureException.mock.calls)).not
      .toContain("provider-token");
  });

  it("soft-revokes one owner Item and clears both token ciphertexts", async () => {
    const terminal = vi.fn(async () => ({ error: null }));
    const query = {
      eq: vi.fn(() => query),
      then: (
        resolve: (value: { error: null }) => unknown,
        reject?: (reason: unknown) => unknown,
      ) => terminal().then(resolve, reject),
    };
    const update = vi.fn(() => query);
    dependencies.admin.mockReturnValue({
      from: vi.fn(() => ({ update })),
    });

    await revokePlaidConnection("user-1", "item-1");

    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      status: "revoked",
      authority: "legacy_unknown",
      verified_at: null,
      access_token_enc: null,
      refresh_token_enc: null,
    }));
    expect(query.eq).toHaveBeenNthCalledWith(1, "user_id", "user-1");
    expect(query.eq).toHaveBeenNthCalledWith(2, "provider", "plaid");
    expect(query.eq).toHaveBeenNthCalledWith(3, "item_id", "item-1");
  });
});
