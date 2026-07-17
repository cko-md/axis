import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  from: vi.fn(),
  transition: vi.fn(),
  consume: vi.fn(),
  emit: vi.fn(),
  capture: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: mocks.getUser }, from: mocks.from }),
}));
vi.mock("@/lib/security/approvalMutations", () => ({
  transitionApproval: (...args: unknown[]) => mocks.transition(...args),
  consumeActionableApproval: (...args: unknown[]) => mocks.consume(...args),
}));
vi.mock("@/lib/observability/events", () => ({
  approvalEventPolicy: (actionClass: unknown, requirement: unknown) => ({
    actionClass,
    requirement,
  }),
  createObservabilityRequestId: () => "99999999-9999-4999-8999-999999999999",
  eventDurationMs: () => 60_000,
  emitServerEvent: (...args: unknown[]) => mocks.emit(...args),
}));
vi.mock("@/lib/observability/captureRouteError", () => ({
  captureRouteError: (...args: unknown[]) => mocks.capture(...args),
}));

import { PATCH } from "./route";

const APPROVAL_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ROW = {
  id: APPROVAL_ID,
  user_id: "user_1",
  task_id: null,
  action_class: "INTERNAL_WRITE",
  requirement: "approval",
  reasons: ["Sensitive write"],
  proposed_action: {
    actor: { kind: "agent", id: "axis" },
    tool: "axis.update",
    summary: "Update a record",
    target: { entityType: "record", entityId: "record_1" },
  },
  status: "pending" as string,
  step_up_verified_at: null,
  decided_at: null as string | null,
  expires_at: null,
  scope: "one_time",
  created_at: "2026-07-16T00:00:00.000Z",
};

function approvalQuery(row = ROW) {
  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  query.select = vi.fn(() => query);
  query.eq = vi.fn(() => query);
  query.maybeSingle = vi.fn(async () => ({ data: row, error: null }));
  return query;
}

function request(action: string) {
  return new NextRequest(`http://axis.test/api/approvals/${APPROVAL_ID}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
  });
}

describe("approval CAS lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUser.mockResolvedValue({ data: { user: { id: "user_1" } }, error: null });
    mocks.from.mockReturnValue(approvalQuery());
  });

  it("allows only the unique approve winner to emit a decision event", async () => {
    mocks.transition.mockResolvedValueOnce({
      ok: true,
      approval: { ...ROW, status: "approved", decided_at: "2026-07-16T00:01:00.000Z" },
    });

    const response = await PATCH(
      request("approve"),
      { params: Promise.resolve({ id: APPROVAL_ID }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.transition).toHaveBeenCalledWith(expect.objectContaining({
      expectedStatus: "pending",
      nextStatus: "approved",
    }));
    expect(mocks.emit).toHaveBeenCalledOnce();
    expect(mocks.emit).toHaveBeenCalledWith("approval.decided", {
      requestId: "99999999-9999-4999-8999-999999999999",
      approvalId: APPROVAL_ID,
      decision: "approved",
      actionClass: "INTERNAL_WRITE",
      requirement: "approval",
      decisionLatencyMs: 60_000,
    });
  });

  it("returns a stale-state conflict when a competing decision wins", async () => {
    mocks.transition.mockResolvedValue({
      ok: false,
      code: "CONFLICT",
      currentStatus: "denied",
    });

    const response = await PATCH(
      request("approve"),
      { params: Promise.resolve({ id: APPROVAL_ID }) },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "STALE_APPROVAL_STATE",
      currentStatus: "denied",
    });
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it("fails visibly when atomic approval mutation is unavailable", async () => {
    mocks.transition.mockResolvedValue({ ok: false, code: "SERVICE_UNAVAILABLE" });

    const response = await PATCH(
      request("deny"),
      { params: Promise.resolve({ id: APPROVAL_ID }) },
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "APPROVAL_MUTATION_UNAVAILABLE" });
    expect(mocks.capture).toHaveBeenCalledOnce();
  });

  it("blocks generic execution of an approval owned by a routine", async () => {
    mocks.from.mockReturnValue(approvalQuery({
      ...ROW,
      status: "approved",
      decided_at: "2026-07-16T00:01:00.000Z",
    }));
    mocks.consume.mockResolvedValue({ ok: false, code: "ROUTINE_OWNED" });

    const response = await PATCH(
      request("execute"),
      { params: Promise.resolve({ id: APPROVAL_ID }) },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "ROUTINE_RESUME_REQUIRED" });
  });

  it("maps execute-time step-up expiry from the locked database row", async () => {
    mocks.from.mockReturnValue(approvalQuery({
      ...ROW,
      status: "approved",
      decided_at: "2026-07-16T00:01:00.000Z",
    }));
    mocks.consume.mockResolvedValue({ ok: false, code: "STEP_UP_STALE" });

    const response = await PATCH(
      request("execute"),
      { params: Promise.resolve({ id: APPROVAL_ID }) },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "NOT_ACTIONABLE",
      reason: "STEP_UP_STALE",
    });
  });

  it("emits only the allowlisted execution metadata after atomic consumption", async () => {
    const approved = {
      ...ROW,
      status: "approved",
      decided_at: "2026-07-16T00:01:00.000Z",
    };
    mocks.from.mockReturnValue(approvalQuery(approved));
    mocks.consume.mockResolvedValue({
      ok: true,
      approval: { ...approved, status: "executed" },
    });

    const response = await PATCH(
      request("execute"),
      { params: Promise.resolve({ id: APPROVAL_ID }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.emit).toHaveBeenCalledWith("approval.executed", {
      requestId: "99999999-9999-4999-8999-999999999999",
      approvalId: APPROVAL_ID,
      actionClass: "INTERNAL_WRITE",
      requirement: "approval",
      stepUpRequired: false,
      executeLatencyMs: 60_000,
    });
    expect(JSON.stringify(mocks.emit.mock.calls)).not.toContain("proposed_action");
  });
});
