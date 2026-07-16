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

vi.mock("@/lib/tasks/taskPersistence", () => ({
  createAgentTaskWithActivity: vi.fn(),
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
