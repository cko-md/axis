import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import {
  concentrationCheckSteps,
  concentrationMaxWeightFromBps,
  concentrationMaxWeightFromSnapshot,
  CONCENTRATION_CHECK_ROUTINE_KEY,
  normalizeConcentrationMaxWeight,
  type ConcentrationCheckOutputs,
} from "./concentrationCheck";
import {
  breachObjective,
  reviewConcentration,
} from "@/lib/skills/concentrationReview";

const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RUN_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TASK_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ACTIVITY_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const maxWeight = 0.5;
const review = reviewConcentration([
  { symbol: "AXIS", value: 80 },
  { symbol: "CASH", value: 20 },
], maxWeight);
const objective = breachObjective(review.breaches[0], maxWeight);

function query(result: { data: unknown; error: unknown }) {
  const value: Record<string, unknown> = {};
  value.select = vi.fn(() => value);
  value.eq = vi.fn(() => value);
  value.not = vi.fn(() => value);
  value.then = (
    resolve: (result: { data: unknown; error: unknown }) => unknown,
    reject: (error: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  return value;
}

function createdPayload() {
  const timestamp = "2026-07-16T12:00:00.000Z";
  return {
    task: {
      id: TASK_ID,
      objective,
      status: "queued",
      context: {
        skill: CONCENTRATION_CHECK_ROUTINE_KEY,
        run_id: RUN_ID,
        evidence: {
          symbol: "AXIS",
          weight: 0.8,
          value: 80,
          overByValue: 30,
          portfolioTotal: 100,
          maxWeight,
        },
      },
      source_routine_id: RUN_ID,
      source_skill: CONCENTRATION_CHECK_ROUTINE_KEY,
      estimated_cost_usd: null,
      actual_cost_usd: null,
      created_at: timestamp,
      updated_at: timestamp,
      completed_at: null,
    },
    activity: {
      id: ACTIVITY_ID,
      kind: "status_change",
      detail: {
        from: null,
        to: "queued",
        by: CONCENTRATION_CHECK_ROUTINE_KEY,
      },
      created_at: timestamp,
    },
  };
}

function createClients(input?: {
  openTasks?: { objective: string }[];
  openTasksError?: Error | null;
  rpcResult?: { data: unknown; error: unknown };
}) {
  const from = vi.fn(() => query({
    data: input?.openTasks ?? [],
    error: input?.openTasksError ?? null,
  }));
  const rpc = vi.fn(async () => input?.rpcResult ?? {
    data: createdPayload(),
    error: null,
  });
  return {
    client: { from } as unknown as SupabaseClient<Database>,
    taskAdmin: { rpc } as unknown as SupabaseClient<Database>,
    from,
    rpc,
  };
}

function createTasksStep(
  client: SupabaseClient<Database>,
  taskAdmin: SupabaseClient<Database>,
) {
  const step = concentrationCheckSteps({
    supabase: client,
    taskAdmin,
    userId: USER_ID,
    maxWeight,
  }).find((candidate) => candidate.key === "create_tasks");
  if (!step) throw new Error("create_tasks step missing");
  return step;
}

function context(): Parameters<ReturnType<typeof createTasksStep>["run"]>[0] {
  return {
    runId: RUN_ID,
    userId: USER_ID,
    outputs: {
      review_concentration: review,
    } satisfies Partial<ConcentrationCheckOutputs>,
    resumed: false,
    claimToken: null,
    assertClaimActive: vi.fn(async () => {}),
  };
}

describe("concentration-check task creation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates each new breach task and its activity through the atomic RPC", async () => {
    const { client, taskAdmin, rpc } = createClients();

    const result = await createTasksStep(client, taskAdmin).run(context());

    expect(result).toEqual({
      created: [{ id: TASK_ID, objective }],
      skipped: 0,
    });
    expect(rpc).toHaveBeenCalledWith("create_agent_task", {
      p_context: expect.objectContaining({
        skill: CONCENTRATION_CHECK_ROUTINE_KEY,
        run_id: RUN_ID,
      }),
      p_estimated_cost_usd: null,
      p_objective: objective,
      p_source_routine_id: RUN_ID,
      p_source_skill: CONCENTRATION_CHECK_ROUTINE_KEY,
      p_source_claim_token: null,
      p_user_id: USER_ID,
    });
  });

  it("renews and propagates the active resume claim before creating a task", async () => {
    const { client, taskAdmin, rpc } = createClients();
    const assertClaimActive = vi.fn(async () => {});
    const activeContext = {
      ...context(),
      resumed: true,
      claimToken: "claim-1",
      assertClaimActive,
    };

    await createTasksStep(client, taskAdmin).run(activeContext);

    expect(assertClaimActive).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith(
      "create_agent_task",
      expect.objectContaining({ p_source_claim_token: "claim-1" }),
    );
  });

  it("fails the routine instead of silently skipping an atomic create failure", async () => {
    const { client, taskAdmin } = createClients({
      rpcResult: { data: null, error: new Error("transaction failed") },
    });

    await expect(
      createTasksStep(client, taskAdmin).run(context()),
    ).rejects.toThrow(
      "TASK_CREATE_FAILED",
    );
  });

  it("does not create duplicates when the matching open task already exists", async () => {
    const { client, taskAdmin, rpc } = createClients({
      openTasks: [{ objective }],
    });

    const result = await createTasksStep(client, taskAdmin).run(context());

    expect(result).toEqual({ created: [], skipped: 1 });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("fails closed when the open-task deduplication read is unavailable", async () => {
    const { client, taskAdmin, rpc } = createClients({
      openTasksError: new Error("database unavailable"),
    });

    await expect(
      createTasksStep(client, taskAdmin).run(context()),
    ).rejects.toThrow(
      "TASKS_UNAVAILABLE",
    );
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("concentration profile inputs", () => {
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
});
