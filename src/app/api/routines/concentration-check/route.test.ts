import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  from: vi.fn(),
  createAdminClient: vi.fn(),
  createSupabaseRoutineStore: vi.fn(),
  executeRoutine: vi.fn(),
  continueRoutineRun: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: mocks.getUser }, from: mocks.from }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: mocks.createAdminClient,
}));
vi.mock("@/lib/routines/executor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/routines/executor")>();
  return {
    ...actual,
    createSupabaseRoutineStore: (...args: unknown[]) => mocks.createSupabaseRoutineStore(...args),
    executeRoutine: (...args: unknown[]) => mocks.executeRoutine(...args),
    continueRoutineRun: (...args: unknown[]) => mocks.continueRoutineRun(...args),
  };
});
vi.mock("@/lib/observability/events", () => ({ emitServerEvent: vi.fn() }));

function profileQuery(profile: { concentration_limit_bps: number; confirmed_at: string } | null) {
  const value: Record<string, unknown> = {};
  value.select = vi.fn(() => value);
  value.eq = vi.fn(() => value);
  value.maybeSingle = vi.fn(async () => ({ data: profile, error: null }));
  return value;
}

function routineRunQuery(run: Record<string, unknown> | null) {
  const value: Record<string, unknown> = {};
  value.select = vi.fn(() => value);
  value.eq = vi.fn(() => value);
  value.maybeSingle = vi.fn(async () => ({ data: run, error: null }));
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
    mocks.createAdminClient.mockReturnValue({ kind: "admin" });
    mocks.createSupabaseRoutineStore.mockReturnValue({});
    mocks.executeRoutine.mockResolvedValue({
      runId: "run_1",
      status: "completed",
      output: { total: 0, breaches: 0, created: [], skipped: 0 },
    });
    mocks.continueRoutineRun.mockResolvedValue({
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
  });

  it("preserves an explicit valid request limit and labels its source", async () => {
    const response = await POST(request({ maxWeight: 0.3 }));
    expect(response.status).toBe(200);
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.executeRoutine).toHaveBeenCalledWith(expect.objectContaining({
      inputSnapshot: { maxWeight: 0.3, maxWeightProvenance: { source_type: "request" } },
    }));
  });

  it("requires trusted routine persistence instead of browser-writable audit rows", async () => {
    mocks.createAdminClient.mockReturnValue(null);

    const response = await POST(request({ maxWeight: 0.3 }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "ROUTINE_SERVICE_NOT_CONFIGURED",
    });
    expect(mocks.executeRoutine).not.toHaveBeenCalled();
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

  it("rejects a quarantined stale-claim run from the generic retry route", async () => {
    const runId = "11111111-1111-4111-8111-111111111111";
    mocks.from.mockReturnValue(routineRunQuery({
      id: runId,
      routine_key: "concentration-check",
      routine_version: 1,
      status: "blocked",
      input_snapshot: { maxWeight: 0.25 },
      paused_step_key: "create_tasks",
      approval_id: "22222222-2222-4222-8222-222222222222",
      idempotency_key: "concentration:test",
      error: "STALE_RESUME_CLAIM_REQUIRES_REVIEW",
      resume_claim_token: null,
      resume_claim_expires_at: null,
    }));

    const response = await POST(request({ runId }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "RUN_REQUIRES_REVIEW",
      status: "blocked",
      resumable: false,
    });
    expect(mocks.continueRoutineRun).not.toHaveBeenCalled();
  });

  it("continues a normal blocked run without approval or claim metadata", async () => {
    const runId = "11111111-1111-4111-8111-111111111111";
    mocks.from.mockReturnValue(routineRunQuery({
      id: runId,
      routine_key: "concentration-check",
      routine_version: 1,
      status: "blocked",
      input_snapshot: { maxWeight: 0.25 },
      paused_step_key: null,
      approval_id: null,
      idempotency_key: null,
      error: "TRANSIENT_PROVIDER_FAILURE",
      resume_claim_token: null,
      resume_claim_expires_at: null,
    }));

    const response = await POST(request({ runId }));

    expect(response.status).toBe(200);
    expect(mocks.continueRoutineRun).toHaveBeenCalledOnce();
  });
});
