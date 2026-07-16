import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  createApproval: vi.fn(),
  capture: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: mocks.getUser } }),
}));
vi.mock("@/lib/security/approvalMutations", () => ({
  createApprovalWithActivity: (...args: unknown[]) => mocks.createApproval(...args),
}));
vi.mock("@/lib/observability/captureRouteError", () => ({
  captureRouteError: (...args: unknown[]) => mocks.capture(...args),
}));

import { POST } from "./route";

function request(body: unknown) {
  return new NextRequest("http://axis.test/api/approvals", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("approval creation boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUser.mockResolvedValue({ data: { user: { id: "user_1" } }, error: null });
  });

  it("persists policy-derived approval scope through the atomic service mutation", async () => {
    mocks.createApproval.mockResolvedValue({
      ok: true,
      approval: { id: "approval_1", status: "pending", action_class: "INTERNAL_WRITE" },
    });

    const response = await POST(request({
      actor: { kind: "user", id: "user_1" },
      tool: "axis.update",
      summary: "Update the record",
      context: { actionClass: "INTERNAL_WRITE" },
      target: { entityType: "record", entityId: "record_1" },
    }));

    expect(response.status).toBe(201);
    expect(mocks.createApproval).toHaveBeenCalledWith(expect.objectContaining({
      user_id: "user_1",
      action_class: "INTERNAL_WRITE",
      requirement: "approval",
      scope: "one_time",
    }));
  });

  it("cannot downgrade financial execution or make its permission persistent", async () => {
    mocks.createApproval.mockResolvedValue({
      ok: true,
      approval: { id: "approval_1", status: "pending", action_class: "FINANCIAL_EXECUTION" },
    });
    const expiresAt = new Date(Date.now() + 60_000).toISOString();

    const response = await POST(request({
      actor: { kind: "user", id: "user_1" },
      tool: "public.place_order",
      summary: "Place one order",
      context: { actionClass: "FINANCIAL_EXECUTION" },
      target: { entityType: "order", accountId: "account_1" },
      amount: { value: 100, currency: "USD", quantity: 1 },
      beforeState: { position: 0 },
      afterState: { position: 1 },
      dataFreshness: { tier: "fresh", retrievedAt: new Date().toISOString() },
      scope: "persistent",
      expiresAt,
      requirement: "approval",
    }));

    expect(response.status).toBe(201);
    expect(mocks.createApproval).toHaveBeenCalledWith(expect.objectContaining({
      action_class: "FINANCIAL_EXECUTION",
      requirement: "approval_step_up",
      scope: "one_time",
    }));
  });

  it("fails visibly when the service-only creation boundary is unavailable", async () => {
    mocks.createApproval.mockResolvedValue({ ok: false, code: "SERVICE_UNAVAILABLE" });

    const response = await POST(request({
      actor: { kind: "user", id: "user_1" },
      tool: "axis.update",
      summary: "Update the record",
      context: { actionClass: "INTERNAL_WRITE" },
      target: { entityType: "record" },
    }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "APPROVAL_MUTATION_UNAVAILABLE" });
    expect(mocks.capture).toHaveBeenCalledOnce();
  });

  it("rejects forged agent/routine attribution at the browser boundary", async () => {
    const response = await POST(request({
      actor: { kind: "agent", id: "axis" },
      tool: "axis.update",
      summary: "Update the record",
      context: { actionClass: "INTERNAL_WRITE" },
      target: { entityType: "record" },
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "INVALID_ACTOR" });
    expect(mocks.createApproval).not.toHaveBeenCalled();
  });

  it.each([
    ["negative amount", { amount: { value: -1, currency: "USD", quantity: 1 } }],
    ["lowercase currency", { amount: { value: 100, currency: "usd", quantity: 1 } }],
    ["zero quantity", { amount: { value: 100, currency: "USD", quantity: 0 } }],
    ["non-object before state", { beforeState: null }],
    ["stale freshness tier", { dataFreshness: { tier: "stale", retrievedAt: new Date().toISOString() } }],
    ["future freshness timestamp", { dataFreshness: { tier: "fresh", retrievedAt: new Date(Date.now() + 5 * 60_000).toISOString() } }],
    ["expiry beyond 24 hours", { expiresAt: new Date(Date.now() + 25 * 60 * 60_000).toISOString() }],
  ])("rejects malformed financial scope: %s", async (_label, patch) => {
    const response = await POST(request({
      actor: { kind: "user", id: "user_1" },
      tool: "public.place_order",
      summary: "Place one order",
      context: { actionClass: "FINANCIAL_EXECUTION" },
      target: { entityType: "order", accountId: "account_1" },
      amount: { value: 100, currency: "USD", quantity: 1 },
      beforeState: { position: 0 },
      afterState: { position: 1 },
      dataFreshness: { tier: "fresh", retrievedAt: new Date().toISOString() },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      ...patch,
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "INVALID_BODY" });
    expect(mocks.createApproval).not.toHaveBeenCalled();
  });
});
