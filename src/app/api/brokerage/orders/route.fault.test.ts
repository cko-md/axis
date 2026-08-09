import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
  getBrokerageCreds: vi.fn(),
  captureRouteError: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("../_lib", () => ({ getBrokerageCreds: mocks.getBrokerageCreds }));
vi.mock("@/lib/observability/providerTiming", () => ({ logRouteTiming: vi.fn() }));
vi.mock("@/lib/observability/captureRouteError", () => ({ captureRouteError: mocks.captureRouteError }));

import { GET, POST } from "./route";
import { preparePublicOrder } from "@/lib/brokerage/publicOrderAdapter";
import { buildFundOrderIntentDraft, hashFundOrderIntentDraft } from "@/lib/brokerage/orderIntent";

const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const IDEMPOTENCY_KEY = "11111111-1111-4111-8111-111111111111";

function authClient(listRows: unknown[] = []) {
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq", "order", "limit"]) chain[method] = vi.fn(() => chain);
  chain.then = (
    resolve: (value: { data: unknown[]; error: null }) => unknown,
    reject: (reason: unknown) => unknown,
  ) => Promise.resolve({ data: listRows, error: null }).then(resolve, reject);
  return {
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: USER_ID } }, error: null })) },
    from: vi.fn(() => chain),
  };
}

function successfulAdmin(intent: Record<string, unknown>) {
  const chain: Record<string, unknown> = {};
  chain.insert = vi.fn(() => chain);
  chain.select = vi.fn(() => chain);
  chain.single = vi.fn(async () => ({ data: intent, error: null }));
  return { from: vi.fn(() => chain), chain };
}

function prepareRequest(overrides: Record<string, unknown> = {}) {
  return new NextRequest("http://axis.test/api/brokerage/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "prepare",
      idempotencyKey: IDEMPOTENCY_KEY,
      order: {
        symbol: "AAPL",
        side: "buy",
        quantity: "1.25",
        type: "market",
        referencePrice: "195.12",
        currency: "USD",
      },
      ...overrides,
    }),
  });
}

describe("order intent boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createClient.mockResolvedValue(authClient());
    mocks.getBrokerageCreds.mockReturnValue({ apiKey: "configured", accountId: "configured" });
  });

  it("persists only an immutable not-submitted intent", async () => {
    const intent = {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      symbol: "AAPL",
      side: "buy",
      quantity_units: 1_250_000,
      quantity_scale: 1_000_000,
      reference_price_minor: 19_512,
      currency: "USD",
      status: "not_submitted",
      created_at: "2026-08-09T21:00:00.000Z",
    };
    const admin = successfulAdmin(intent);
    mocks.createAdminClient.mockReturnValue(admin);

    const response = await POST(prepareRequest());

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ intent, submitted: false, deduplicated: false });
    expect(admin.from).toHaveBeenCalledTimes(1);
    expect(admin.from).toHaveBeenCalledWith("fund_order_intents");
    expect(admin.chain.insert).toHaveBeenCalledWith(expect.objectContaining({
      user_id: USER_ID,
      idempotency_key: IDEMPOTENCY_KEY,
      action_class: "FINANCIAL_EXECUTION",
      status: "not_submitted",
      reference_price_source: "manual_estimate",
    }));
    expect(admin.chain.insert).not.toHaveBeenCalledWith(expect.objectContaining({ executed_at: expect.anything() }));
  });

  it("rejects an idempotency-key payload mismatch instead of creating another row", async () => {
    const lookup: Record<string, unknown> = {};
    for (const method of ["select", "eq"]) lookup[method] = vi.fn(() => lookup);
    lookup.maybeSingle = vi.fn(async () => ({ data: { payload_hash: "f".repeat(64) }, error: null }));
    const insert: Record<string, unknown> = {};
    insert.insert = vi.fn(() => insert);
    insert.select = vi.fn(() => insert);
    insert.single = vi.fn(async () => ({ data: null, error: { code: "23505" } }));
    const admin = { from: vi.fn().mockReturnValueOnce(insert).mockReturnValueOnce(lookup) };
    mocks.createAdminClient.mockReturnValue(admin);

    const response = await POST(prepareRequest());

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "IDEMPOTENCY_PAYLOAD_CONFLICT" });
    expect(admin.from).toHaveBeenCalledWith("fund_order_intents");
  });

  it("returns the same intent for an ambiguous retry with the same key and payload", async () => {
    const prepared = preparePublicOrder({
      symbol: "AAPL",
      side: "buy",
      quantity: "1.25",
      type: "market",
      referencePrice: "195.12",
      currency: "USD",
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const payloadHash = hashFundOrderIntentDraft(buildFundOrderIntentDraft(prepared.data));
    const existing = {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      symbol: "AAPL",
      side: "buy",
      quantity_units: 1_250_000,
      quantity_scale: 1_000_000,
      reference_price_minor: 19_512,
      currency: "USD",
      status: "not_submitted",
      created_at: "2026-08-09T21:00:00.000Z",
      payload_hash: payloadHash,
    };
    const lookup: Record<string, unknown> = {};
    for (const method of ["select", "eq"]) lookup[method] = vi.fn(() => lookup);
    lookup.maybeSingle = vi.fn(async () => ({ data: existing, error: null }));
    const insert: Record<string, unknown> = {};
    insert.insert = vi.fn(() => insert);
    insert.select = vi.fn(() => insert);
    insert.single = vi.fn(async () => ({ data: null, error: { code: "23505" } }));
    const admin = { from: vi.fn().mockReturnValueOnce(insert).mockReturnValueOnce(lookup) };
    mocks.createAdminClient.mockReturnValue(admin);

    const response = await POST(prepareRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      intent: { id: existing.id, status: "not_submitted" },
      deduplicated: true,
      submitted: false,
    });
  });

  it("fails visibly and writes nothing when intent persistence is unavailable", async () => {
    mocks.createAdminClient.mockReturnValue(null);

    const response = await POST(prepareRequest());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "ORDER_INTENT_PERSISTENCE_UNAVAILABLE" });
    expect(mocks.captureRouteError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({
      code: "ORDER_INTENT_PERSISTENCE_UNAVAILABLE",
    }));
  });

  it("keeps forged approval ids non-actionable and reports no submission", async () => {
    const response = await POST(prepareRequest({ action: "submit", approvalId: "forged" }));

    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({
      error: "BROKER_SUBMIT_NOT_ENABLED",
      submitted: false,
    });
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
  });

  it("rejects unknown actions instead of silently preparing an intent", async () => {
    const response = await POST(prepareRequest({ action: "unexpected" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "UNKNOWN_ORDER_ACTION" });
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
  });

  it("lists only owner-scoped order intents", async () => {
    const client = authClient([{ id: "intent-1", status: "not_submitted" }]);
    mocks.createClient.mockResolvedValue(client);

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ intents: [{ id: "intent-1", status: "not_submitted" }] });
    expect(client.from).toHaveBeenCalledWith("fund_order_intents");
  });
});
