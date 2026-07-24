import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  verifyPlaidWebhook: vi.fn(),
  createAdminClient: vi.fn(),
  decrypt: vi.fn(),
  syncPlaidTransactions: vi.fn(),
  captureMessage: vi.fn(),
}));

vi.mock("../_lib", () => ({
  verifyPlaidWebhook: mocks.verifyPlaidWebhook,
  readBoundedPlaidBody: async (request: Request, max: number) => {
    const value = await request.text();
    return Buffer.byteLength(value) > max ? null : value;
  },
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("@/lib/crypto", () => ({ decrypt: mocks.decrypt }));
vi.mock("@/lib/fund/syncPlaidTransactions", () => ({
  syncPlaidTransactions: mocks.syncPlaidTransactions,
}));
vi.mock("@sentry/nextjs", () => ({
  captureMessage: mocks.captureMessage,
  captureException: vi.fn(),
}));

import { POST } from "./route";

function request(body: unknown) {
  return new NextRequest("http://axis.test/api/plaid/webhook", {
    method: "POST",
    headers: { "plaid-verification": "signed" },
    body: JSON.stringify(body),
  });
}

function admin(connection: unknown) {
  const updates: unknown[] = [];
  return {
    updates,
    client: {
      from: vi.fn(() => ({
        select: vi.fn(() => {
          const chain = {
            eq: vi.fn(() => chain),
            maybeSingle: vi.fn(async () => ({ data: connection, error: null })),
          };
          return chain;
        }),
        update: vi.fn((value: unknown) => {
          updates.push(value);
          const chain = {
            eq: vi.fn(() => chain),
            or: vi.fn(() => chain),
            select: vi.fn(() => chain),
            maybeSingle: vi.fn(async () => ({ data: { id: "connection" }, error: null })),
          };
          return chain;
        }),
      })),
    },
  };
}

const verifiedConnection = {
  id: "connection",
  user_id: "user",
  status: "linked",
  authority: "provider_verified",
  verified_at: "2026-07-23T12:00:00.000Z",
  access_token_enc: "ciphertext",
  provider_event_at: null,
};

describe("Plaid signed webhook processing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifyPlaidWebhook.mockResolvedValue({
      iat: Math.floor(Date.now() / 1_000),
      request_body_sha256: "a".repeat(64),
    });
    mocks.decrypt.mockReturnValue("access-token");
    mocks.syncPlaidTransactions.mockResolvedValue({ synced: 1 });
    mocks.createAdminClient.mockReturnValue(admin(verifiedConnection).client);
  });

  it("treats signed USER_PERMISSION_REVOKED as authoritative removal and clears credentials", async () => {
    const db = admin(verifiedConnection);
    mocks.createAdminClient.mockReturnValue(db.client);
    const response = await POST(request({
      webhook_type: "ITEM",
      webhook_code: "USER_PERMISSION_REVOKED",
      item_id: "item-id",
    }));
    expect(response.status).toBe(200);
    expect(db.updates).toEqual([expect.objectContaining({
      status: "revoked",
      authority: "legacy_unknown",
      verified_at: null,
      access_token_enc: null,
      refresh_token_enc: null,
    })]);
    expect(mocks.syncPlaidTransactions).not.toHaveBeenCalled();
  });

  it("records login-required without logging provider messages", async () => {
    const db = admin(verifiedConnection);
    mocks.createAdminClient.mockReturnValue(db.client);
    await POST(request({
      webhook_type: "ITEM",
      webhook_code: "ERROR",
      item_id: "item-id",
      error: { error_code: "ITEM_LOGIN_REQUIRED", error_message: "private provider content" },
    }));
    expect(db.updates).toEqual([expect.objectContaining({
      status: "error",
      action_required: "login_required",
    })]);
    expect(JSON.stringify(mocks.captureMessage.mock.calls)).not.toContain("private provider content");
  });

  it("never syncs transactions for a legacy linked row", async () => {
    mocks.createAdminClient.mockReturnValue(admin({
      ...verifiedConnection,
      authority: "legacy_unknown",
      verified_at: null,
    }).client);
    expect((await POST(request({
      webhook_type: "TRANSACTIONS",
      webhook_code: "SYNC_UPDATES_AVAILABLE",
      item_id: "item-id",
    }))).status).toBe(200);
    expect(mocks.syncPlaidTransactions).not.toHaveBeenCalled();
  });

  it("cleanly rejects null/scalar JSON and skips a previously removed Item", async () => {
    expect((await POST(request(null))).status).toBe(400);
    expect((await POST(request("scalar"))).status).toBe(400);
    mocks.createAdminClient.mockReturnValue(admin(null).client);
    const response = await POST(request({
      webhook_type: "TRANSACTIONS",
      webhook_code: "SYNC_UPDATES_AVAILABLE",
      item_id: "removed-item",
    }));
    expect(await response.json()).toEqual({ ok: true, skipped: true });
  });
});
