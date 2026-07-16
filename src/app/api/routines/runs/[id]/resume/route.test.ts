import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  claim: vi.fn(),
  release: vi.fn(),
  createStore: vi.fn(),
  resumeRoutine: vi.fn(),
  concentrationSteps: vi.fn(),
  maxWeight: vi.fn(),
  capture: vi.fn(),
  emit: vi.fn(),
}));

const claims = {
  claim: (...args: unknown[]) => mocks.claim(...args),
  release: (...args: unknown[]) => mocks.release(...args),
};

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: mocks.getUser } }),
}));
vi.mock("@/lib/routines/resumeClaims", () => ({
  createRoutineResumeClaims: () => claims,
}));
vi.mock("@/lib/routines/executor", () => ({
  createSupabaseRoutineStore: (...args: unknown[]) => mocks.createStore(...args),
  resumeRoutine: (...args: unknown[]) => mocks.resumeRoutine(...args),
  RoutineExecutionError: class RoutineExecutionError extends Error {
    constructor(message: string, readonly runId: string) {
      super(message);
      this.name = "RoutineExecutionError";
    }
  },
}));
vi.mock("@/lib/routines/concentrationCheck", () => ({
  CONCENTRATION_CHECK_ROUTINE_KEY: "concentration_review",
  buildConcentrationCheckOutput: vi.fn(),
  concentrationCheckSteps: (...args: unknown[]) => mocks.concentrationSteps(...args),
  concentrationMaxWeightFromSnapshot: (...args: unknown[]) => mocks.maxWeight(...args),
}));
vi.mock("@/lib/observability/captureRouteError", () => ({
  captureRouteError: (...args: unknown[]) => mocks.capture(...args),
}));
vi.mock("@/lib/observability/events", () => ({
  createObservabilityRequestId: () => "99999999-9999-4999-8999-999999999999",
  emitServerEvent: (...args: unknown[]) => mocks.emit(...args),
  routineEventErrorCode: (error: unknown) =>
    error instanceof Error && error.message === "HOLDINGS_UNAVAILABLE"
      ? "HOLDINGS_UNAVAILABLE"
      : "UNEXPECTED_ROUTINE_FAILURE",
}));

import { POST } from "./route";

const CLAIMED = {
  ok: true,
  value: {
    kind: "claimed",
    runId: "run-1",
    status: "running",
    routineKey: "concentration_review",
    routineVersion: 2,
    inputSnapshot: { maxWeight: 0.2 },
    stepKey: "create_tasks",
    approvalId: "approval-1",
    idempotencyKey: "stored-key",
    resumeAttempt: 1,
    claimExpiresAt: "2026-07-16T18:00:00.000Z",
    reused: false,
  },
};

function request() {
  return new NextRequest("http://axis.test/api/routines/runs/run-1/resume", {
    method: "POST",
  });
}

function callRoute() {
  return POST(request(), { params: Promise.resolve({ id: "run-1" }) });
}

describe("POST /api/routines/runs/[id]/resume", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUser.mockResolvedValue({
      data: { user: { id: "user-1" } },
      error: null,
    });
    mocks.claim.mockResolvedValue(CLAIMED);
    mocks.release.mockResolvedValue({
      ok: true,
      value: {
        status: "waiting_for_approval",
        stepKey: "create_tasks",
        approvalId: "approval-1",
        idempotencyKey: "stored-key",
        resumeAttempt: 1,
      },
    });
    mocks.createStore.mockReturnValue({ resumeMode: "claimed" });
    mocks.concentrationSteps.mockReturnValue([]);
    mocks.maxWeight.mockReturnValue(0.2);
    mocks.resumeRoutine.mockResolvedValue({
      runId: "run-1",
      status: "completed",
      output: { total: 100, breaches: 1, created: [], skipped: 1 },
      outputs: {},
    });
  });

  it("claims before execution and passes the persisted pause metadata to the claimed executor", async () => {
    const response = await callRoute();

    expect(response.status).toBe(200);
    expect(mocks.claim).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-1",
      runId: "run-1",
      claimToken: expect.any(String),
    }));
    expect(mocks.claim.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.resumeRoutine.mock.invocationCallOrder[0]);
    expect(mocks.createStore).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        claimToken: expect.any(String),
        claims,
      }),
    );
    expect(mocks.resumeRoutine).toHaveBeenCalledWith(expect.objectContaining({
      store: { resumeMode: "claimed" },
      run: expect.objectContaining({
        id: "run-1",
        status: "running",
        paused_step_key: "create_tasks",
        approval_id: "approval-1",
        idempotency_key: "stored-key",
      }),
    }));
    expect(mocks.release).not.toHaveBeenCalled();
    expect(mocks.emit).toHaveBeenCalledWith("routine.run.completed", {
      requestId: "99999999-9999-4999-8999-999999999999",
      routine: "concentration_review",
      runId: "run-1",
      status: "completed",
      breaches: 1,
      tasksCreated: 0,
      tasksSkipped: 1,
      resumedFromApproval: true,
    });
  });

  it("returns a busy conflict for a concurrent submit without starting work", async () => {
    mocks.claim.mockResolvedValue({
      ok: false,
      code: "BUSY",
      claimExpiresAt: "2026-07-16T18:00:00.000Z",
    });

    const response = await callRoute();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "BUSY",
      runId: "run-1",
      claimExpiresAt: "2026-07-16T18:00:00.000Z",
    });
    expect(mocks.resumeRoutine).not.toHaveBeenCalled();
  });

  it("returns the stored terminal result on an idempotent retry", async () => {
    mocks.claim.mockResolvedValue({
      ok: true,
      value: {
        kind: "terminal",
        runId: "run-1",
        status: "completed",
        output: { total: 100, breaches: 1, created: [], skipped: 1 },
        actualCostUsd: 0,
        completedAt: "2026-07-16T17:59:00.000Z",
      },
    });

    const response = await callRoute();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      runId: "run-1",
      status: "completed",
      total: 100,
      idempotentReplay: true,
    });
    expect(mocks.resumeRoutine).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it("releases an unsupported claimed routine instead of stranding its lease", async () => {
    mocks.claim.mockResolvedValue({
      ...CLAIMED,
      value: { ...CLAIMED.value, routineKey: "unknown_routine" },
    });

    const response = await callRoute();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "UNSUPPORTED_ROUTINE",
      routine: "unknown_routine",
    });
    expect(mocks.release).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-1",
      runId: "run-1",
      claimToken: expect.any(String),
      errorCode: null,
    }));
    expect(mocks.resumeRoutine).not.toHaveBeenCalled();
  });

  it("surfaces and captures an unsupported-routine release failure", async () => {
    mocks.claim.mockResolvedValue({
      ...CLAIMED,
      value: { ...CLAIMED.value, routineKey: "unknown_routine" },
    });
    mocks.release.mockResolvedValue({ ok: false, code: "RPC_FAILED" });

    const response = await callRoute();

    expect(response.status).toBe(500);
    expect(mocks.capture).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        operation: "release_unsupported",
        code: "RPC_FAILED",
      }),
    );
  });

  it("normalizes resumed-work failure content before Sentry or structured logs", async () => {
    const privateText = "person@example.com has balance 9000";
    mocks.resumeRoutine.mockRejectedValue(new Error(privateText));

    const response = await callRoute();

    expect(response.status).toBe(500);
    expect(mocks.emit).toHaveBeenCalledWith("routine.run.blocked", {
      requestId: "99999999-9999-4999-8999-999999999999",
      routine: "concentration_review",
      runId: "run-1",
      errorCode: "UNEXPECTED_ROUTINE_FAILURE",
      stage: "resume",
      resumedFromApproval: true,
    });
    expect(JSON.stringify(mocks.emit.mock.calls)).not.toContain(privateText);
    expect(JSON.stringify(mocks.capture.mock.calls)).not.toContain(privateText);
  });

  it("rejects unauthenticated calls before creating a resume claim", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });

    const response = await callRoute();

    expect(response.status).toBe(401);
    expect(mocks.claim).not.toHaveBeenCalled();
  });
});
