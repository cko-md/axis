import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/lib/supabase/database.types";
import { createAgentTaskWithActivity } from "@/lib/tasks/taskPersistence";
import {
  concentrationCheckSteps,
  concentrationMaxWeightFromBps,
  concentrationMaxWeightFromSnapshot,
  normalizeConcentrationMaxWeight,
  routineTaskIdempotencyKey,
} from "./concentrationCheck";

const marketMocks = vi.hoisted(() => ({
  fetchSnapshot: vi.fn(),
  getPolygonApiKey: vi.fn(),
}));

vi.mock("@/lib/tasks/taskPersistence", () => ({
  createAgentTaskWithActivity: vi.fn(),
}));
vi.mock("@/lib/massive/client", () => ({
  fetchSnapshot: marketMocks.fetchSnapshot,
  getPolygonApiKey: marketMocks.getPolygonApiKey,
}));

const TASK_OBJECTIVE =
  "Review concentration: AAPL is 80.0% of the portfolio (target max 25%)";
const TASK_KEY = routineTaskIdempotencyKey({
  runId: "run-1",
  stepKey: "create_tasks",
  sideEffectKey: "AAPL",
  resumeIdempotencyKey: "stored-resume-key",
});
const REVIEW_OUTPUT = {
  review_concentration: {
    total: 100,
    positions: [{ symbol: "AAPL", value: 80, weight: 0.8 }],
    breaches: [{
      symbol: "AAPL",
      value: 80,
      weight: 0.8,
      overByValue: 55,
    }],
  },
};

describe("concentration profile inputs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    marketMocks.getPolygonApiKey.mockReturnValue("market-key");
    marketMocks.fetchSnapshot.mockResolvedValue({
      price: "10.00",
      chg: 0,
      source: "massive",
      asOf: "2026-07-23T12:00:00.000Z",
      observedAt: "2026-07-23T12:00:00.000Z",
      snapshotUpdatedAt: "2026-07-23T12:00:00.000Z",
      marketSession: "open",
    });
  });

  it("fails closed on manual holdings instead of treating cost basis as market value", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-23T12:00:00.000Z"));
    const load = concentrationCheckSteps({
      supabase: concentrationQueryClient({
        holdings: [{
          symbol: "AAPL",
          shares: "1",
          cost_basis: "999999.00",
          currency: "USD",
          authority: "manual",
          source: "manual",
          provider: null,
          provider_record_id: null,
          connection_id: null,
          retrieved_at: null,
          reconciliation_state: null,
          generation_id: null,
        }],
      }),
      userId: "user-1",
      maxWeight: 0.25,
    }).find((step) => step.key === "load_holdings");
    if (!load) throw new Error("load_holdings step missing");

    await expect(load.run({
      runId: "run-1",
      userId: "user-1",
      resumed: false,
      idempotencyKey: null,
      outputs: {},
    })).rejects.toThrow("CONCENTRATION_HOLDING_PROVENANCE_UNAVAILABLE");
    expect(marketMocks.fetchSnapshot).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("derives concentration inputs from fresh quotes, never historical basis", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-23T12:00:00.000Z"));
    const generationId = "11111111-1111-4111-8111-111111111111";
    const load = concentrationCheckSteps({
      supabase: concentrationQueryClient({
        holdings: [{
          symbol: "AAPL",
          shares: "2",
          cost_basis: "999999.00",
          currency: "USD",
          authority: "provider",
          source: "plaid",
          provider: "plaid",
          provider_record_id: "holding-1",
          connection_id: "connection-1",
          retrieved_at: "2026-07-23T12:00:00.000Z",
          reconciliation_state: "matched",
          generation_id: generationId,
        }],
        connections: [{
          id: "connection-1",
          provider: "plaid",
          status: "linked",
          authority: "provider_verified",
          verified_at: "2026-07-23T12:00:00.000Z",
        }],
        coverage: [{
          connection_id: "connection-1",
          provider: "plaid",
          component: "holdings",
          complete: true,
          record_count: 1,
          retrieved_at: "2026-07-23T12:00:00.000Z",
          availability_status: "available",
          generation_id: generationId,
          generation_hash: "a".repeat(64),
        }],
      }),
      userId: "user-1",
      maxWeight: 0.25,
    }).find((step) => step.key === "load_holdings");
    if (!load) throw new Error("load_holdings step missing");

    await expect(load.run({
      runId: "run-1",
      userId: "user-1",
      resumed: false,
      idempotencyKey: null,
      outputs: {},
    })).resolves.toEqual([{ symbol: "AAPL", value: 20 }]);
    vi.useRealTimers();
  });

  it("rejects non-USD holdings before any quote or task side effect", async () => {
    const generationId = "11111111-1111-4111-8111-111111111111";
    const load = concentrationCheckSteps({
      supabase: concentrationQueryClient({
        holdings: [{
          symbol: "AAPL",
          shares: "2",
          currency: "EUR",
          authority: "provider",
          source: "plaid",
          provider: "plaid",
          provider_record_id: "holding-1",
          connection_id: "connection-1",
          retrieved_at: new Date().toISOString(),
          reconciliation_state: "matched",
          generation_id: generationId,
        }],
      }),
      userId: "user-1",
      maxWeight: 0.25,
    }).find((step) => step.key === "load_holdings");
    if (!load) throw new Error("load_holdings step missing");

    await expect(load.run({
      runId: "run-1",
      userId: "user-1",
      resumed: false,
      idempotencyKey: null,
      outputs: {},
    })).rejects.toThrow("CONCENTRATION_CURRENCY_UNSUPPORTED");
    expect(marketMocks.fetchSnapshot).not.toHaveBeenCalled();
    expect(createAgentTaskWithActivity).not.toHaveBeenCalled();
  });

  it("converts integer basis points deterministically", () => {
    expect(concentrationMaxWeightFromBps(2000)).toBe(0.2);
    expect(concentrationMaxWeightFromBps(100)).toBe(0.01);
    expect(concentrationMaxWeightFromBps(20.5)).toBeNull();
    expect(concentrationMaxWeightFromBps(10001)).toBeNull();
  });

  it("rejects unsafe request weights instead of accepting negative or >100% thresholds", () => {
    expect(normalizeConcentrationMaxWeight(0.3)).toBe(0.3);
    expect(normalizeConcentrationMaxWeight(0)).toBeNull();
    expect(normalizeConcentrationMaxWeight(-0.1)).toBeNull();
    expect(normalizeConcentrationMaxWeight(1.01)).toBeNull();
    expect(normalizeConcentrationMaxWeight(Number.NaN)).toBeNull();
  });

  it("replays a valid snapshotted weight and fails closed to the legacy default", () => {
    expect(concentrationMaxWeightFromSnapshot({ maxWeight: 0.2 })).toBe(0.2);
    expect(concentrationMaxWeightFromSnapshot({ maxWeight: -1 })).toBe(0.25);
    expect(concentrationMaxWeightFromSnapshot({ maxWeight: 2 })).toBe(0.25);
  });

  it("derives side-effect keys from the stored paused-step key on resume", () => {
    const resumed = routineTaskIdempotencyKey({
      runId: "run-1",
      stepKey: "create_tasks",
      sideEffectKey: "AAPL",
      resumeIdempotencyKey: "stored-resume-key",
    });
    const repeated = routineTaskIdempotencyKey({
      runId: "run-1",
      stepKey: "create_tasks",
      sideEffectKey: "AAPL",
      resumeIdempotencyKey: "stored-resume-key",
    });
    const fresh = routineTaskIdempotencyKey({
      runId: "run-1",
      stepKey: "create_tasks",
      sideEffectKey: "AAPL",
      resumeIdempotencyKey: null,
    });

    expect(resumed).toBe(repeated);
    expect(resumed).toMatch(/^routine-task:v1:[a-f0-9]{64}$/);
    expect(resumed).not.toBe(fresh);
    expect(routineTaskIdempotencyKey({
      runId: "run-1",
      stepKey: "create_tasks",
      sideEffectKey: "MSFT",
      resumeIdempotencyKey: "stored-resume-key",
    })).not.toBe(resumed);
  });

  it("reconstructs an idempotent RPC winner as a task attributable to the run", async () => {
    const supabase = taskQueryClient();
    vi.mocked(createAgentTaskWithActivity).mockResolvedValue({
      ok: true,
      outcome: "existing",
      created: false,
      task: taskRow(),
    });

    const result = await runCreateTasksStep(supabase);

    expect(result).toEqual({
      created: [{ id: "task-existing", objective: TASK_OBJECTIVE }],
      skipped: 0,
    });
  });

  it("keeps final task output stable when retry reconstructs a committed task", async () => {
    vi.mocked(createAgentTaskWithActivity).mockResolvedValue({
      ok: true,
      outcome: "created",
      created: true,
      task: taskRow(),
    });
    const first = await runCreateTasksStep(taskQueryClient());

    vi.mocked(createAgentTaskWithActivity).mockClear();
    const retried = await runCreateTasksStep(taskQueryClient({
      openObjectives: [TASK_OBJECTIVE],
      routineTasks: [{
        id: "task-existing",
        objective: TASK_OBJECTIVE,
        idempotency_key: TASK_KEY,
      }],
    }));

    expect(retried).toEqual(first);
    expect(createAgentTaskWithActivity).not.toHaveBeenCalled();
  });

  it("only skips an unrelated pre-existing open objective", async () => {
    const result = await runCreateTasksStep(taskQueryClient({
      openObjectives: [TASK_OBJECTIVE],
    }));

    expect(result).toEqual({ created: [], skipped: 1 });
    expect(createAgentTaskWithActivity).not.toHaveBeenCalled();
  });
});

function concentrationQueryClient(input: {
  holdings: unknown[];
  connections?: unknown[];
  coverage?: unknown[];
}): SupabaseClient<Database> {
  const rows: Record<string, unknown[]> = {
    fund_holdings: input.holdings,
    fund_connections: input.connections ?? [],
    fund_provider_coverage: input.coverage ?? [],
  };
  return {
    from: vi.fn((table: string) => {
      const result = { data: rows[table] ?? [], error: null };
      const chain: Record<string, unknown> = {};
      chain.select = vi.fn(() => chain);
      chain.eq = vi.fn(() => chain);
      chain.limit = vi.fn(() => chain);
      chain.then = (resolve: (value: typeof result) => unknown) => Promise.resolve(result).then(resolve);
      return chain;
    }),
  } as unknown as SupabaseClient<Database>;
}

function taskQueryClient(input: {
  openObjectives?: string[];
  routineTasks?: {
    id: string;
    objective: string;
    idempotency_key: string | null;
  }[];
} = {}): SupabaseClient<Database> {
  const openTasks = (input.openObjectives ?? []).map((objective) => ({ objective }));
  const routineTasks = input.routineTasks ?? [];
  return {
    from: vi.fn(() => ({
      select: vi.fn((columns: string) => columns === "objective"
        ? {
            eq: vi.fn(() => ({
              not: vi.fn(async () => ({ data: openTasks, error: null })),
            })),
          }
        : {
            eq: vi.fn(() => ({
              eq: vi.fn(async () => ({ data: routineTasks, error: null })),
            })),
          }),
    })),
  } as unknown as SupabaseClient<Database>;
}

function taskRow(): Database["public"]["Tables"]["agent_tasks"]["Row"] {
  return {
    actual_cost_usd: null,
    completed_at: null,
    context: {},
    created_at: "2026-07-16T00:00:00.000Z",
    estimated_cost_usd: null,
    id: "task-existing",
    idempotency_key: TASK_KEY,
    objective: TASK_OBJECTIVE,
    source_routine_id: "run-1",
    source_skill: "concentration_review",
    status: "queued",
    updated_at: "2026-07-16T00:00:00.000Z",
    user_id: "user-1",
  };
}

async function runCreateTasksStep(supabase: SupabaseClient<Database>) {
  const createTasks = concentrationCheckSteps({
    supabase,
    userId: "user-1",
    maxWeight: 0.25,
  }).find((step) => step.key === "create_tasks");
  if (!createTasks) throw new Error("create_tasks step missing");
  return await createTasks.run({
    runId: "run-1",
    userId: "user-1",
    resumed: true,
    idempotencyKey: "stored-resume-key",
    outputs: REVIEW_OUTPUT,
  });
}
