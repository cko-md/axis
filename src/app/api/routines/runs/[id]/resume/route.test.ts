import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  sessionFrom: vi.fn(),
  adminFrom: vi.fn(),
  adminRpc: vi.fn(),
  createAdminClient: vi.fn(),
  resumeRoutine: vi.fn(),
  createSupabaseRoutineStore: vi.fn(),
  emitServerEvent: vi.fn(),
  captureRouteError: vi.fn(),
}));

const sessionClient = {
  auth: { getUser: mocks.getUser },
  from: mocks.sessionFrom,
};
const adminClient = {
  from: mocks.adminFrom,
  rpc: mocks.adminRpc,
};

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => sessionClient,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: mocks.createAdminClient,
}));
vi.mock("@/lib/routines/executor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/routines/executor")>();
  return {
    ...actual,
    resumeRoutine: mocks.resumeRoutine,
    createSupabaseRoutineStore: mocks.createSupabaseRoutineStore,
  };
});
vi.mock("@/lib/observability/events", () => ({
  emitServerEvent: mocks.emitServerEvent,
}));
vi.mock("@/lib/observability/captureRouteError", () => ({
  captureRouteError: mocks.captureRouteError,
}));

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const APPROVAL_ID = "22222222-2222-4222-8222-222222222222";
const context = { params: Promise.resolve({ id: RUN_ID }) };
const request = new NextRequest(`http://axis.test/api/routines/runs/${RUN_ID}/resume`, {
  method: "POST",
});

const output = {
  total: 100,
  breaches: 1,
  created: [{ id: "task-1", objective: "Review ABC concentration" }],
  skipped: 0,
};

function run(status = "waiting_for_approval", overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    routine_key: "concentration_review",
    routine_version: 1,
    status,
    input_snapshot: { maxWeight: 0.25 },
    output: null,
    paused_step_key: "create_tasks",
    approval_id: APPROVAL_ID,
    idempotency_key: "idem-1",
    resume_claim_token: null,
    resume_claimed_at: null,
    ...overrides,
  };
}

function approval(status = "approved", overrides: Record<string, unknown> = {}) {
  return {
    id: APPROVAL_ID,
    task_id: null,
    action_class: "DRAFT",
    requirement: "approval",
    reasons: ["user confirmation"],
    proposed_action: {
      actor: {
        kind: "routine",
        id: "concentration_review",
        routineVersion: 1,
      },
      tool: "routine.continue",
      summary: "Continue the concentration review",
      target: { entityType: "routine_run", entityId: RUN_ID },
    },
    status,
    step_up_verified_at: null,
    expires_at: null,
    scope: "one_time",
    execution_claim_token: null,
    execution_run_id: null,
    ...overrides,
  };
}

function query(result: { data: unknown; error: unknown }) {
  const value: Record<string, unknown> = {};
  value.select = vi.fn(() => value);
  value.update = vi.fn(() => value);
  value.eq = vi.fn(() => value);
  value.maybeSingle = vi.fn(async () => result);
  return value;
}

function useSessionQueries(...queries: ReturnType<typeof query>[]) {
  const queue = [...queries];
  mocks.sessionFrom.mockImplementation(() => queue.shift());
}

function useAdminQueries(...queries: ReturnType<typeof query>[]) {
  const queue = [...queries];
  mocks.adminFrom.mockImplementation(() => queue.shift());
}

describe("POST /api/routines/runs/[id]/resume", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUser.mockResolvedValue({
      data: { user: { id: "user_1" } },
      error: null,
    });
    mocks.createAdminClient.mockReturnValue(adminClient);
    mocks.createSupabaseRoutineStore.mockReturnValue({ kind: "store" });
    mocks.adminRpc.mockResolvedValue({ data: true, error: null });
  });

  it("returns the persisted result idempotently after finalization", async () => {
    useSessionQueries(query({
      data: run("completed", {
        output,
        paused_step_key: null,
        approval_id: null,
        idempotency_key: null,
      }),
      error: null,
    }));

    const response = await POST(request, context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      runId: RUN_ID,
      status: "completed",
      ...output,
    });
    expect(mocks.adminRpc).not.toHaveBeenCalled();
    expect(mocks.resumeRoutine).not.toHaveBeenCalled();
  });

  it("lets only one caller claim the run and approval", async () => {
    useSessionQueries(
      query({ data: run(), error: null }),
      query({ data: approval(), error: null }),
    );
    mocks.adminRpc.mockResolvedValueOnce({
      data: { ok: false, code: "RUN_ALREADY_CLAIMED" },
      error: null,
    });

    const response = await POST(request, context);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "RUN_ALREADY_RESUMING" });
    expect(mocks.resumeRoutine).not.toHaveBeenCalled();
  });

  it("rejects an actionable approval that is not bound to this exact run", async () => {
    useSessionQueries(
      query({ data: run(), error: null }),
      query({
        data: approval("approved", {
          proposed_action: {
            actor: { kind: "routine", id: "another_routine", routineVersion: 1 },
            tool: "routine.continue",
            summary: "Continue another run",
            target: { entityType: "routine_run", entityId: RUN_ID },
          },
        }),
        error: null,
      }),
    );

    const response = await POST(request, context);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "APPROVAL_SCOPE_MISMATCH" });
    expect(mocks.adminRpc).not.toHaveBeenCalled();
    expect(mocks.resumeRoutine).not.toHaveBeenCalled();
  });

  it("passes the fenced claim into the executor and returns the completed output", async () => {
    useSessionQueries(
      query({ data: run(), error: null }),
      query({ data: approval(), error: null }),
    );
    mocks.adminRpc.mockResolvedValueOnce({
      data: { ok: true, claimToken: "ignored-server-echo" },
      error: null,
    });
    mocks.resumeRoutine.mockResolvedValue({
      runId: RUN_ID,
      status: "completed",
      output,
      outputs: {},
    });

    const response = await POST(request, context);

    expect(response.status).toBe(200);
    const claimCall = mocks.adminRpc.mock.calls[0];
    expect(claimCall[0]).toBe("claim_routine_approval_resume");
    expect(claimCall[1]).toMatchObject({
      p_user_id: "user_1",
      p_run_id: RUN_ID,
      p_approval_id: APPROVAL_ID,
      p_claim_token: expect.any(String),
    });
    const claimToken = claimCall[1].p_claim_token;
    expect(mocks.createSupabaseRoutineStore).toHaveBeenCalledWith(
      adminClient,
      expect.objectContaining({
        resumeApprovalClaim: {
          userId: "user_1",
          approvalId: APPROVAL_ID,
          claimToken,
        },
      }),
    );
    expect(mocks.resumeRoutine).toHaveBeenCalledWith(
      expect.objectContaining({
        preclaimed: true,
        run: expect.objectContaining({ resume_claim_token: claimToken }),
      }),
    );
  });

  it("does not steal a fresh in-flight claim", async () => {
    useSessionQueries(
      query({
        data: run("running", {
          resume_claim_token: "33333333-3333-4333-8333-333333333333",
          resume_claimed_at: new Date().toISOString(),
        }),
        error: null,
      }),
      query({
        data: run("running", {
          resume_claim_token: "33333333-3333-4333-8333-333333333333",
          resume_claimed_at: new Date().toISOString(),
        }),
        error: null,
      }),
    );
    mocks.adminRpc.mockResolvedValueOnce({ data: false, error: null });

    const response = await POST(request, context);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "RUN_ALREADY_RESUMING" });
    expect(mocks.adminRpc).toHaveBeenCalledWith(
      "recover_stale_routine_approval_resume",
      {
        p_user_id: "user_1",
        p_run_id: RUN_ID,
        p_approval_id: APPROVAL_ID,
      },
    );
    expect(mocks.resumeRoutine).not.toHaveBeenCalled();
  });

  it("quarantines a stale claim instead of starting an overlapping worker", async () => {
    useSessionQueries(
      query({
        data: run("running", {
          resume_claim_token: "33333333-3333-4333-8333-333333333333",
          resume_claimed_at: "2026-07-16T00:00:00.000Z",
        }),
        error: null,
      }),
      query({
        data: run("blocked", {
          resume_claim_token: null,
          resume_claimed_at: null,
        }),
        error: null,
      }),
    );
    mocks.adminRpc.mockResolvedValueOnce({ data: true, error: null });

    const response = await POST(request, context);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "RUN_STALE_CLAIM_REQUIRES_REVIEW",
      status: "blocked",
    });
    expect(mocks.adminRpc.mock.calls.map(([name]) => name)).toEqual([
      "recover_stale_routine_approval_resume",
    ]);
    expect(mocks.resumeRoutine).not.toHaveBeenCalled();
  });

  it("releases a failed claim and reports that the run is truly resumable", async () => {
    useSessionQueries(
      query({ data: run(), error: null }),
      query({ data: approval(), error: null }),
    );
    useAdminQueries(
      query({ data: run(), error: null }),
      query({ data: approval(), error: null }),
    );
    mocks.adminRpc
      .mockResolvedValueOnce({ data: { ok: true }, error: null })
      .mockResolvedValueOnce({ data: true, error: null });
    mocks.resumeRoutine.mockRejectedValue(new Error("HOLDINGS_UNAVAILABLE"));

    const response = await POST(request, context);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: "RUN_BLOCKED",
      runId: RUN_ID,
      resumable: true,
    });
    expect(mocks.adminRpc.mock.calls[1]).toEqual([
      "release_routine_approval_resume",
      expect.objectContaining({ p_error: "HOLDINGS_UNAVAILABLE" }),
    ]);
    expect(mocks.captureRouteError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "HOLDINGS_UNAVAILABLE" }),
      expect.objectContaining({ operation: "resume", code: "HOLDINGS_UNAVAILABLE" }),
    );
  });

  it("returns success when finalization committed but its response was lost", async () => {
    useSessionQueries(
      query({ data: run(), error: null }),
      query({ data: approval(), error: null }),
    );
    useAdminQueries(
      query({
        data: run("completed", {
          output,
          paused_step_key: null,
          approval_id: null,
          idempotency_key: null,
        }),
        error: null,
      }),
      query({ data: approval("executed"), error: null }),
    );
    mocks.adminRpc
      .mockResolvedValueOnce({ data: { ok: true }, error: null })
      .mockResolvedValueOnce({ data: false, error: null });
    mocks.resumeRoutine.mockRejectedValue(new Error("RUN_FINALIZE_CLAIM_LOST"));

    const response = await POST(request, context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      runId: RUN_ID,
      status: "completed",
      ...output,
    });
  });

  it("recovers a committed claim after the claim response is lost", async () => {
    let claimedToken = "";
    useSessionQueries(
      query({ data: run(), error: null }),
      query({ data: approval(), error: null }),
    );
    mocks.adminRpc.mockImplementationOnce(
      async (_name: string, args: { p_claim_token: string }) => {
        claimedToken = args.p_claim_token;
        return { data: null, error: new Error("connection reset") };
      },
    );
    mocks.adminFrom.mockImplementation((table: string) => query({
      data: table === "routine_runs"
        ? run("running", { resume_claim_token: claimedToken })
        : approval("executing", {
          execution_claim_token: claimedToken,
          execution_run_id: RUN_ID,
        }),
      error: null,
    }));
    mocks.resumeRoutine.mockResolvedValue({
      runId: RUN_ID,
      status: "completed",
      output,
      outputs: {},
    });

    const response = await POST(request, context);

    expect(response.status).toBe(200);
    expect(mocks.resumeRoutine).toHaveBeenCalledWith(
      expect.objectContaining({
        run: expect.objectContaining({ resume_claim_token: claimedToken }),
      }),
    );
  });
});
