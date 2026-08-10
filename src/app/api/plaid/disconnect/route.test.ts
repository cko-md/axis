import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
  decrypt: vi.fn(),
  getPlaidCreds: vi.fn(),
  admitPlaidMutation: vi.fn(),
  timedProviderFetch: vi.fn(),
  redisRateLimit: vi.fn(),
  memoryRateLimit: vi.fn(),
  captureRouteError: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("@/lib/crypto", () => ({ decrypt: mocks.decrypt }));
vi.mock("../_lib", () => ({
  admitPlaidMutation: mocks.admitPlaidMutation,
  getPlaidCreds: mocks.getPlaidCreds,
  PLAID_API_VERSION: "2020-09-14",
  plaidHost: () => "https://plaid.invalid",
  readBoundedPlaidBody: async (request: Request, max: number) => {
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > max) return null;
    const value = await request.text();
    return Buffer.byteLength(value) > max ? null : value;
  },
  readBoundedPlaidJson: async (response: Response) => response.json().catch(() => null),
}));
vi.mock("@/lib/observability/providerTiming", () => ({
  timedProviderFetch: mocks.timedProviderFetch,
}));
vi.mock("@/lib/ratelimit", () => ({
  redisRateLimit: mocks.redisRateLimit,
  memoryRateLimit: mocks.memoryRateLimit,
}));
vi.mock("@/lib/observability/captureRouteError", () => ({
  captureRouteError: mocks.captureRouteError,
}));

import { POST } from "./route";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const CONNECTION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function request(
  body: unknown = { connectionId: CONNECTION_ID },
  headers?: Record<string, string>,
) {
  return new NextRequest("http://axis.test/api/plaid/disconnect", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function adminClient(options: {
  connection?: { id: string; status: string; access_token_enc: string | null } | null;
  loadError?: unknown;
  revokeError?: unknown;
  revoked?: { id: string } | null;
} = {}) {
  const updates: unknown[] = [];
  const from = vi.fn(() => ({
    select: vi.fn(() => {
      const chain = {
        eq: vi.fn(() => chain),
        maybeSingle: vi.fn(async () => ({
          data: options.connection === undefined
            ? { id: CONNECTION_ID, status: "linked", access_token_enc: "ciphertext" }
            : options.connection,
          error: options.loadError ?? null,
        })),
      };
      return chain;
    }),
    update: vi.fn((payload: unknown) => {
      updates.push(payload);
      const chain = {
        eq: vi.fn(() => chain),
        neq: vi.fn(() => chain),
        select: vi.fn(() => chain),
        maybeSingle: vi.fn(async () => ({
          data: options.revoked === undefined ? { id: CONNECTION_ID } : options.revoked,
          error: options.revokeError ?? null,
        })),
      };
      return chain;
    }),
  }));
  return { client: { from }, from, updates };
}

describe("Plaid disconnect authority boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createClient.mockResolvedValue({
      auth: { getUser: vi.fn(async () => ({ data: { user: { id: USER_ID } }, error: null })) },
    });
    const db = adminClient();
    mocks.createAdminClient.mockReturnValue(db.client);
    mocks.decrypt.mockReturnValue("access-token");
    mocks.getPlaidCreds.mockReturnValue({ clientId: "client", secret: "secret", env: "sandbox" });
    mocks.admitPlaidMutation.mockResolvedValue("allowed");
    mocks.redisRateLimit.mockResolvedValue({ success: true });
    mocks.memoryRateLimit.mockReturnValue({ success: true });
    mocks.timedProviderFetch.mockResolvedValue(new Response(
      JSON.stringify({ request_id: "request-1" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
  });

  it("returns observable auth-backend failure instead of mislabeling it unauthorized", async () => {
    mocks.createClient.mockResolvedValue({
      auth: { getUser: vi.fn(async () => ({ data: { user: null }, error: new Error("down") })) },
    });
    expect((await POST(request())).status).toBe(503);
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
  });

  it("enforces admission and body bounds before provider or admin work", async () => {
    mocks.admitPlaidMutation.mockResolvedValueOnce("limited");
    expect((await POST(request())).status).toBe(429);
    expect(mocks.createAdminClient).not.toHaveBeenCalled();

    mocks.admitPlaidMutation.mockResolvedValueOnce("allowed");
    expect((await POST(request(undefined, { "content-length": "1025" }))).status).toBe(413);
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
  });

  it("scopes the lookup to the owner and never calls Plaid for a hidden connection", async () => {
    const db = adminClient({ connection: null });
    mocks.createAdminClient.mockReturnValue(db.client);
    expect((await POST(request())).status).toBe(404);
    expect(mocks.timedProviderFetch).not.toHaveBeenCalled();
    expect(db.updates).toHaveLength(0);
  });

  it("returns unavailable when the server admin path is missing", async () => {
    mocks.createAdminClient.mockReturnValue(null);
    expect((await POST(request())).status).toBe(503);
    expect(mocks.timedProviderFetch).not.toHaveBeenCalled();
  });

  it("persists durable pending intent without claiming local revocation on provider failure", async () => {
    for (const providerResult of [
      new Response("{}", { status: 500 }),
      new Response("{}", { status: 429 }),
      new Error("timeout"),
    ]) {
      const db = adminClient();
      mocks.createAdminClient.mockReturnValueOnce(db.client);
      if (providerResult instanceof Error) {
        mocks.timedProviderFetch.mockRejectedValueOnce(providerResult);
      } else {
        mocks.timedProviderFetch.mockResolvedValueOnce(providerResult);
      }
      const response = await POST(request());
      expect([429, 502, 503]).toContain(response.status);
      expect(db.updates).toEqual([expect.objectContaining({
        status: "error",
        action_required: "disconnect_pending",
      })]);
    }
  });

  it("requires literal provider success then atomically revokes and clears tokens", async () => {
    const db = adminClient();
    mocks.createAdminClient.mockReturnValue(db.client);

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(db.updates).toEqual([
      expect.objectContaining({
        status: "error",
        action_required: "disconnect_pending",
      }),
      expect.objectContaining({
        status: "revoked",
        authority: "legacy_unknown",
        verified_at: null,
        action_required: null,
        access_token_enc: null,
        refresh_token_enc: null,
      }),
    ]);
    const providerInit = mocks.timedProviderFetch.mock.calls[0]?.[1] as { body: string };
    expect(JSON.parse(providerInit.body)).toMatchObject({ access_token: "access-token" });
  });

  it("treats a fully-cleared revoked connection as an idempotent replay", async () => {
    const db = adminClient({
      connection: { id: CONNECTION_ID, status: "revoked", access_token_enc: null },
    });
    mocks.createAdminClient.mockReturnValue(db.client);

    const body = await (await POST(request())).json();

    expect(body).toEqual({ ok: true, alreadyRevoked: true });
    expect(mocks.timedProviderFetch).not.toHaveBeenCalled();
    expect(db.updates).toHaveLength(0);
  });
});
