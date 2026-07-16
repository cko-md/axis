import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  from: vi.fn(),
  executeRoutine: vi.fn(),
  emit: vi.fn(),
  capture: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: mocks.getUser }, from: mocks.from }),
}));
vi.mock("@/lib/routines/executor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/routines/executor")>();
  return {
    ...actual,
    createSupabaseRoutineStore: () => ({}),
    executeRoutine: (...args: unknown[]) => mocks.executeRoutine(...args),
  };
});
vi.mock("@/lib/observability/events", () => ({
  createObservabilityRequestId: () => "99999999-9999-4999-8999-999999999999",
  emitServerEvent: (...args: unknown[]) => mocks.emit(...args),
  routineEventErrorCode: (error: unknown) =>
    error instanceof Error && error.message === "HOLDINGS_UNAVAILABLE"
      ? "HOLDINGS_UNAVAILABLE"
      : "UNEXPECTED_ROUTINE_FAILURE",
}));
vi.mock("@/lib/observability/captureRouteError", () => ({
  captureRouteError: (...args: unknown[]) => mocks.capture(...args),
}));

function profileQuery(profile: { concentration_limit_bps: number; confirmed_at: string } | null) {
  const value: Record<string, unknown> = {};
  value.select = vi.fn(() => value);
  value.eq = vi.fn(() => value);
  value.maybeSingle = vi.fn(async () => ({ data: profile, error: null }));
  return value;
}

function request(body: unknown) {
  return new NextRequest("http://axis.test/api/routines/concentration-check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("concentration-check financial profile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUser.mockResolvedValue({ data: { user: { id: "user_1" } }, error: null });
    mocks.executeRoutine.mockResolvedValue({
      runId: "run_1",
      status: "completed",
      output: { total: 0, breaches: 0, created: [], skipped: 0 },
    });
  });

  it("uses the confirmed integer-bps profile limit with provenance", async () => {
    mocks.from.mockReturnValue(profileQuery({ concentration_limit_bps: 1750, confirmed_at: "2026-07-15T20:00:00.000Z" }));
    const response = await POST(request({}));
    expect(response.status).toBe(200);
    expect(mocks.executeRoutine).toHaveBeenCalledWith(expect.objectContaining({
      inputSnapshot: {
        maxWeight: 0.175,
        maxWeightProvenance: {
          source_type: "financial_operating_profile",
          confirmed_at: "2026-07-15T20:00:00.000Z",
        },
      },
    }));
    expect(mocks.emit).toHaveBeenCalledWith("routine.run.completed", {
      requestId: "99999999-9999-4999-8999-999999999999",
      routine: "concentration_review",
      runId: "run_1",
      status: "completed",
      breaches: 0,
      tasksCreated: 0,
      tasksSkipped: 0,
      resumedFromApproval: false,
    });
  });

  it("preserves an explicit valid request limit and labels its source", async () => {
    const response = await POST(request({ maxWeight: 0.3 }));
    expect(response.status).toBe(200);
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.executeRoutine).toHaveBeenCalledWith(expect.objectContaining({
      inputSnapshot: { maxWeight: 0.3, maxWeightProvenance: { source_type: "request" } },
    }));
  });

  it("falls back to the existing 25% default when no profile exists", async () => {
    mocks.from.mockReturnValue(profileQuery(null));
    await POST(request({}));
    expect(mocks.executeRoutine).toHaveBeenCalledWith(expect.objectContaining({
      inputSnapshot: { maxWeight: 0.25, maxWeightProvenance: { source_type: "routine_default" } },
    }));
  });

  it.each([{ maxWeight: -1 }, { maxWeight: 1.01 }, null])(
    "rejects malformed or unsafe routine input: %j",
    async (body) => {
      const response = await POST(request(body));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "INVALID_ROUTINE_INPUT" });
      expect(mocks.executeRoutine).not.toHaveBeenCalled();
      expect(mocks.from).not.toHaveBeenCalled();
    },
  );

  it("normalizes unexpected failure content before Sentry or structured logs", async () => {
    const privateText = "person@example.com has balance 9000";
    mocks.from.mockReturnValue(profileQuery(null));
    mocks.executeRoutine.mockRejectedValue(new Error(privateText));

    const response = await POST(request({}));

    expect(response.status).toBe(500);
    expect(mocks.emit).toHaveBeenCalledWith("routine.run.blocked", {
      requestId: "99999999-9999-4999-8999-999999999999",
      routine: "concentration_review",
      runId: undefined,
      errorCode: "UNEXPECTED_ROUTINE_FAILURE",
      stage: "execute",
      resumedFromApproval: false,
    });
    expect(JSON.stringify(mocks.emit.mock.calls)).not.toContain(privateText);
    expect(JSON.stringify(mocks.capture.mock.calls)).not.toContain(privateText);
  });
});
