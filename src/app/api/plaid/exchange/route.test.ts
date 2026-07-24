import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
  admitPlaidMutation: vi.fn(),
  getPlaidCreds: vi.fn(),
  timedProviderFetch: vi.fn(),
  savePlaidConnection: vi.fn(),
  captureRouteError: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("@/lib/fund/plaidTokens", () => ({ savePlaidConnection: mocks.savePlaidConnection }));
vi.mock("@/lib/observability/providerTiming", () => ({ timedProviderFetch: mocks.timedProviderFetch }));
vi.mock("@/lib/observability/captureRouteError", () => ({ captureRouteError: mocks.captureRouteError }));
vi.mock("../_lib", () => ({
  admitPlaidMutation: mocks.admitPlaidMutation,
  getPlaidCreds: mocks.getPlaidCreds,
  PLAID_API_VERSION: "2020-09-14",
  plaidHost: () => "https://plaid.invalid",
  readBoundedPlaidBody: async (request: Request, max: number) => {
    const body = await request.text();
    return Buffer.byteLength(body) > max ? null : body;
  },
  readBoundedPlaidJson: async (response: Response) => response.json().catch(() => null),
}));

import { POST } from "./route";

const USER_ID = "11111111-1111-4111-8111-111111111111";

function request() {
  return new NextRequest("http://axis.test/api/plaid/exchange", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ public_token: "public-token", institution: "Bank" }),
  });
}

function admin(existing: unknown[] = [], ambiguous: unknown = null) {
  const updates: unknown[] = [];
  return {
    updates,
    client: {
      from: vi.fn(() => ({
        select: vi.fn(() => {
          const chain = {
            eq: vi.fn(() => chain),
            neq: vi.fn(() => chain),
            limit: vi.fn(async () => ({ data: existing, error: null })),
            maybeSingle: vi.fn(async () => ({ data: ambiguous, error: null })),
          };
          return chain;
        }),
        update: vi.fn((value: unknown) => {
          updates.push(value);
          const chain = {
            eq: vi.fn(() => chain),
            neq: vi.fn(() => chain),
            select: vi.fn(() => chain),
            maybeSingle: vi.fn(async () => ({ data: { id: "connection-new" }, error: null })),
          };
          return chain;
        }),
      })),
    },
  };
}

describe("Plaid public-token exchange", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createClient.mockResolvedValue({
      auth: { getUser: vi.fn(async () => ({ data: { user: { id: USER_ID } }, error: null })) },
    });
    mocks.createAdminClient.mockReturnValue(admin().client);
    mocks.admitPlaidMutation.mockResolvedValue("allowed");
    mocks.getPlaidCreds.mockReturnValue({ clientId: "client", secret: "secret", env: "sandbox" });
    mocks.savePlaidConnection.mockResolvedValue(true);
    mocks.timedProviderFetch.mockResolvedValue(new Response(JSON.stringify({
      access_token: "access-token",
      item_id: "item-id",
      request_id: "request-id",
    }), { status: 200 }));
  });

  it("blocks every non-revoked existing Item before exchanging the public token", async () => {
    mocks.createAdminClient.mockReturnValue(admin([{ id: "existing" }]).client);
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect(mocks.timedProviderFetch).not.toHaveBeenCalled();
    expect(mocks.savePlaidConnection).not.toHaveBeenCalled();
  });

  it("fails closed when distributed admission is unavailable or limited", async () => {
    mocks.admitPlaidMutation.mockResolvedValueOnce("unavailable");
    expect((await POST(request())).status).toBe(503);
    mocks.admitPlaidMutation.mockResolvedValueOnce("limited");
    expect((await POST(request())).status).toBe(429);
    expect(mocks.timedProviderFetch).not.toHaveBeenCalled();
  });

  it("stores a successful exchange as provider verified through the canonical save boundary", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(mocks.savePlaidConnection).toHaveBeenCalledWith(
      USER_ID,
      "access-token",
      "item-id",
      "Bank",
    );
    const init = mocks.timedProviderFetch.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toMatchObject({ "Plaid-Version": "2020-09-14" });
  });

  it("removes the new Item and proves no active local row after ambiguous save failure", async () => {
    mocks.savePlaidConnection.mockResolvedValueOnce(false);
    mocks.timedProviderFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "access-token",
        item_id: "item-id",
        request_id: "exchange-request",
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ request_id: "remove-request" }), { status: 200 }));
    expect((await POST(request())).status).toBe(502);
    expect(mocks.timedProviderFetch).toHaveBeenCalledTimes(2);
  });

  it("returns high-signal cleanup-required when provider compensation cannot be proved", async () => {
    mocks.savePlaidConnection.mockResolvedValueOnce(false);
    mocks.timedProviderFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "access-token",
        item_id: "item-id",
        request_id: "exchange-request",
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response("{}", { status: 500 }));
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "PLAID_CLEANUP_REQUIRED" });
  });
});
