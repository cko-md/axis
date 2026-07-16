import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { PATCH } from "./route";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  from: vi.fn(),
  adminFrom: vi.fn(),
  adminRpc: vi.fn(),
  createAdminClient: vi.fn(),
  emitServerEvent: vi.fn(),
  captureRouteError: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: mocks.getUser },
    from: mocks.from,
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: mocks.createAdminClient,
}));
vi.mock("@/lib/observability/events", () => ({
  emitServerEvent: mocks.emitServerEvent,
}));
vi.mock("@/lib/observability/captureRouteError", () => ({
  captureRouteError: mocks.captureRouteError,
}));

const ID = "22222222-2222-4222-8222-222222222222";
const context = { params: Promise.resolve({ id: ID }) };

const proposedAction = {
  actor: { kind: "agent", id: "envoy_1" },
  tool: "notes.create_draft",
  summary: "Create a private draft",
  target: { entityType: "note" },
};

function approval(status: string) {
  return {
    id: ID,
    task_id: null,
    action_class: "DRAFT",
    requirement: "approval",
    reasons: ["user confirmation"],
    proposed_action: proposedAction,
    status,
    step_up_verified_at: null,
    decided_at: status === "approved" || status === "executed"
      ? "2026-07-16T00:01:00.000Z"
      : null,
    expires_at: null,
    scope: "one_time",
    created_at: "2026-07-16T00:00:00.000Z",
  };
}

function query(result: { data: unknown; error: unknown }) {
  const value: Record<string, unknown> = {};
  value.select = vi.fn(() => value);
  value.update = vi.fn(() => value);
  value.eq = vi.fn(() => value);
  value.in = vi.fn(() => value);
  value.maybeSingle = vi.fn(async () => result);
  return value as {
    update: ReturnType<typeof vi.fn>;
    eq: ReturnType<typeof vi.fn>;
  };
}

function request(action: "approve" | "deny" | "execute") {
  return new NextRequest(`http://axis.test/api/approvals/${ID}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
  });
}

function useSessionQueries(...queries: ReturnType<typeof query>[]) {
  const queue = [...queries];
  mocks.from.mockImplementation(() => queue.shift());
}

function useAdminQueries(...queries: ReturnType<typeof query>[]) {
  const queue = [...queries];
  mocks.adminFrom.mockImplementation(() => queue.shift());
}

describe("PATCH /api/approvals/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUser.mockResolvedValue({
      data: { user: { id: "user_1" } },
      error: null,
    });
    mocks.adminRpc.mockResolvedValue({ data: null, error: null });
    mocks.createAdminClient.mockReturnValue({
      from: mocks.adminFrom,
      rpc: mocks.adminRpc,
    });
  });

  it("reads with the session and approves through an owner-scoped admin CAS", async () => {
    const read = query({ data: approval("pending"), error: null });
    const decision = query({ data: approval("approved"), error: null });
    useSessionQueries(read);
    useAdminQueries(decision);

    const response = await PATCH(request("approve"), context);

    expect(response.status).toBe(200);
    expect(mocks.from).toHaveBeenCalledTimes(1);
    expect(mocks.adminFrom).toHaveBeenCalledWith("approvals");
    expect(decision.eq).toHaveBeenCalledWith("user_id", "user_1");
    expect(decision.eq).toHaveBeenCalledWith("id", ID);
    expect(decision.eq).toHaveBeenCalledWith("status", "pending");
    expect(mocks.emitServerEvent).toHaveBeenCalledWith(
      "approval.decided",
      expect.objectContaining({ decision: "approved" }),
    );
  });

  it.each(["approve", "deny"] as const)(
    "returns 409 when a concurrent %s decision loses the pending-state claim",
    async (action) => {
      const read = query({ data: approval("pending"), error: null });
      const decision = query({ data: null, error: null });
      useSessionQueries(read);
      useAdminQueries(decision);

      const response = await PATCH(request(action), context);

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error: "STALE_APPROVAL",
        expected: "pending",
      });
      expect(decision.eq).toHaveBeenCalledWith("status", "pending");
      expect(mocks.emitServerEvent).not.toHaveBeenCalled();
      expect(mocks.captureRouteError).not.toHaveBeenCalled();
    },
  );

  it("executes through the database-time approval gate while status is approved", async () => {
    const read = query({ data: approval("approved"), error: null });
    const linkedRun = query({ data: null, error: null });
    useSessionQueries(read, linkedRun);
    mocks.adminRpc.mockResolvedValue({
      data: { ok: true, approval: approval("executed") },
      error: null,
    });

    const response = await PATCH(request("execute"), context);

    expect(response.status).toBe(200);
    expect(mocks.adminRpc).toHaveBeenCalledWith("execute_approval", {
      p_user_id: "user_1",
      p_approval_id: ID,
    });
    expect(mocks.emitServerEvent).toHaveBeenCalledWith(
      "approval.executed",
      expect.objectContaining({ approvalId: ID }),
    );
  });

  it("returns 409 when a concurrent execute loses the approved-state claim", async () => {
    const read = query({ data: approval("approved"), error: null });
    const linkedRun = query({ data: null, error: null });
    useSessionQueries(read, linkedRun);
    mocks.adminRpc.mockResolvedValue({
      data: { ok: false, code: "STALE_APPROVAL" },
      error: null,
    });

    const response = await PATCH(request("execute"), context);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "STALE_APPROVAL",
      expected: "approved",
    });
    expect(mocks.emitServerEvent).not.toHaveBeenCalled();
    expect(mocks.captureRouteError).not.toHaveBeenCalled();
  });

  it.each([
    ["APPROVAL_EXPIRED", { error: "EXPIRED" }],
    [
      "APPROVAL_STEP_UP_REQUIRED",
      { error: "NOT_ACTIONABLE", reason: "STEP_UP_REQUIRED", missing: [] },
    ],
    [
      "APPROVAL_STEP_UP_STALE",
      { error: "NOT_ACTIONABLE", reason: "STEP_UP_STALE", missing: [] },
    ],
    [
      "APPROVAL_POLICY_MISMATCH",
      { error: "NOT_ACTIONABLE", reason: "POLICY_MISMATCH", missing: [] },
    ],
  ] as const)(
    "fails closed when the atomic gate returns %s",
    async (code, expected) => {
      const read = query({ data: approval("approved"), error: null });
      const linkedRun = query({ data: null, error: null });
      useSessionQueries(read, linkedRun);
      mocks.adminRpc.mockResolvedValue({
        data: { ok: false, code },
        error: null,
      });

      const response = await PATCH(request("execute"), context);

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual(expected);
      expect(mocks.emitServerEvent).not.toHaveBeenCalled();
    },
  );

  it("surfaces an atomic execution RPC failure", async () => {
    const read = query({ data: approval("approved"), error: null });
    const linkedRun = query({ data: null, error: null });
    useSessionQueries(read, linkedRun);
    const rpcError = new Error("database unavailable");
    mocks.adminRpc.mockResolvedValue({ data: null, error: rpcError });

    const response = await PATCH(request("execute"), context);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "APPROVAL_UPDATE_FAILED" });
    expect(mocks.captureRouteError).toHaveBeenCalledWith(
      rpcError,
      expect.objectContaining({ operation: "execute" }),
    );
  });

  it("routes linked routine approvals through the atomic resume gate", async () => {
    const read = query({ data: approval("approved"), error: null });
    const linkedRun = query({
      data: { id: "11111111-1111-4111-8111-111111111111", status: "waiting_for_approval" },
      error: null,
    });
    useSessionQueries(read, linkedRun);

    const response = await PATCH(request("execute"), context);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "ROUTINE_RESUME_REQUIRED",
      runId: "11111111-1111-4111-8111-111111111111",
      resumeUrl: "/api/routines/runs/11111111-1111-4111-8111-111111111111/resume",
    });
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
    expect(mocks.adminFrom).not.toHaveBeenCalled();
  });

  it.each([
    ["approve", "pending"],
    ["execute", "approved"],
  ] as const)(
    "returns a visible 503 instead of falling back to the session for %s",
    async (action, status) => {
      const read = query({ data: approval(status), error: null });
      const linkedRun = query({ data: null, error: null });
      useSessionQueries(read, linkedRun);
      mocks.createAdminClient.mockReturnValue(null);

      const response = await PATCH(request(action), context);

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        error: "APPROVAL_WRITE_UNAVAILABLE",
        message: "Approval writes are temporarily unavailable.",
      });
      expect(mocks.from).toHaveBeenCalledTimes(action === "execute" ? 2 : 1);
      expect(mocks.adminFrom).not.toHaveBeenCalled();
      expect(mocks.emitServerEvent).not.toHaveBeenCalled();
    },
  );

  it.each(["approve", "deny", "execute"] as const)(
    "treats an executing approval as in-flight for %s",
    async (action) => {
      const read = query({ data: approval("executing"), error: null });
      useSessionQueries(read);

      const response = await PATCH(request(action), context);

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error: "APPROVAL_IN_FLIGHT",
        status: "executing",
      });
      expect(mocks.createAdminClient).not.toHaveBeenCalled();
      expect(mocks.adminFrom).not.toHaveBeenCalled();
    },
  );
});
