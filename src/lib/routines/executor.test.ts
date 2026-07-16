import { describe, expect, it, vi } from "vitest";
import type { Json } from "@/lib/supabase/database.types";
import {
  continueRoutineRun,
  createSupabaseRoutineStore,
  executeRoutine,
  pauseForApproval,
  resumeRoutine,
  type RoutineExecutionStore,
  type RoutineRunForResume,
  type RoutineStep,
  type RoutineStepRunSnapshot,
} from "./executor";

type Outputs = {
  a: { value: number };
  b: { value: number };
  c: { sum: number };
};

class MemoryRoutineStore implements RoutineExecutionStore {
  runs = new Map<string, RoutineRunForResume & { output?: Json | null; error?: string | null }>();
  steps: RoutineStepRunSnapshot[] = [];
  nextRun = 1;
  nextStep = 1;

  async createRun(input: Parameters<RoutineExecutionStore["createRun"]>[0]) {
    const id = `run-${this.nextRun++}`;
    this.runs.set(id, {
      id,
      routine_key: input.routineKey,
      routine_version: input.routineVersion,
      status: "running",
      input_snapshot: input.inputSnapshot,
      paused_step_key: null,
      approval_id: null,
      idempotency_key: null,
    });
    return { id };
  }

  async listStepRuns(runId: string) {
    return this.steps.filter((step) => step.id.startsWith(`${runId}:`));
  }

  async startStep(input: Parameters<RoutineExecutionStore["startStep"]>[0]) {
    const id = `${input.runId}:step-${this.nextStep++}`;
    this.steps.push({
      id,
      step_key: input.stepKey,
      ordinal: input.ordinal,
      status: "running",
      output_snapshot: null,
    });
    return { id, ordinal: input.ordinal };
  }

  async completeStep(input: Parameters<RoutineExecutionStore["completeStep"]>[0]) {
    const step = this.requireStep(input.stepRunId);
    step.status = "succeeded";
    step.output_snapshot = input.outputSnapshot;
  }

  async failStep(input: Parameters<RoutineExecutionStore["failStep"]>[0]) {
    this.requireStep(input.stepRunId).status = "failed";
  }

  async renewRunClaim() {}

  async markRunRunning(
    runId: string,
    _userId: string,
    expectedStatus: RoutineRunForResume["status"] = "waiting_for_approval",
  ) {
    const run = this.requireRun(runId);
    if (run.status !== expectedStatus) return false;
    run.status = "running";
    return true;
  }

  async markRunWaitingForApproval(input: Parameters<RoutineExecutionStore["markRunWaitingForApproval"]>[0]) {
    const run = this.requireRun(input.runId);
    run.status = "waiting_for_approval";
    run.paused_step_key = input.pausedStepKey;
    run.approval_id = input.approvalId;
    run.idempotency_key = input.idempotencyKey;
  }

  async completeRun(input: Parameters<RoutineExecutionStore["completeRun"]>[0]) {
    const run = this.requireRun(input.runId);
    run.status = input.status;
    run.output = input.output;
    run.paused_step_key = null;
    run.approval_id = null;
    run.idempotency_key = null;
  }

  async failRun(input: Parameters<RoutineExecutionStore["failRun"]>[0]) {
    const run = this.requireRun(input.runId);
    run.status = input.status;
    run.error = input.error;
    run.paused_step_key = null;
    run.approval_id = null;
    run.idempotency_key = null;
  }

  seedRun(run: RoutineRunForResume) {
    this.runs.set(run.id, { ...run });
  }

  seedStep(step: RoutineStepRunSnapshot) {
    this.steps.push(step);
    const n = Number(step.id.split(":step-")[1]);
    if (Number.isFinite(n)) this.nextStep = Math.max(this.nextStep, n + 1);
  }

  private requireRun(id: string) {
    const run = this.runs.get(id);
    if (!run) throw new Error(`missing run ${id}`);
    return run;
  }

  private requireStep(id: string) {
    const step = this.steps.find((candidate) => candidate.id === id);
    if (!step) throw new Error(`missing step ${id}`);
    return step;
  }
}

function buildOutput(outputs: Partial<Outputs>): Json {
  return { total: outputs.c?.sum ?? 0 };
}

function awaitedQuery(result: { data: unknown; error: unknown }) {
  const query: Record<string, unknown> = {};
  for (const method of ["select", "insert", "update", "eq"]) {
    query[method] = vi.fn(() => query);
  }
  query.maybeSingle = vi.fn(async () => result);
  query.then = (
    resolve: (value: { data: unknown; error: unknown }) => unknown,
    reject: (error: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  return query;
}

describe("routine executor", () => {
  it("pauses a run for approval and stores pause metadata without completing the paused step", async () => {
    const store = new MemoryRoutineStore();
    const steps: RoutineStep<Outputs>[] = [
      { key: "a", run: async () => ({ value: 1 }) },
      { key: "b", run: async () => pauseForApproval("approval-1", "idem-1") },
      { key: "c", run: async () => ({ sum: 3 }) },
    ];

    const result = await executeRoutine({
      store,
      userId: "user-1",
      routineKey: "test",
      steps,
      buildRunOutput: buildOutput,
    });

    expect(result.status).toBe("waiting_for_approval");
    const run = store.runs.get("run-1");
    expect(run?.status).toBe("waiting_for_approval");
    expect(run?.paused_step_key).toBe("b");
    expect(run?.approval_id).toBe("approval-1");
    expect(run?.idempotency_key).toBe("idem-1");
    expect(store.steps.map((step) => [step.step_key, step.status])).toEqual([
      ["a", "succeeded"],
      ["b", "running"],
    ]);
  });

  it("resumes from the paused step and replays completed outputs without recomputing them", async () => {
    const store = new MemoryRoutineStore();
    store.seedRun({
      id: "run-1",
      routine_key: "test",
      routine_version: 1,
      status: "waiting_for_approval",
      input_snapshot: {},
      paused_step_key: "b",
      approval_id: "approval-1",
      idempotency_key: "idem-1",
    });
    store.seedStep({
      id: "run-1:step-1",
      step_key: "a",
      ordinal: 1,
      status: "succeeded",
      output_snapshot: { value: 2 },
    });
    store.seedStep({
      id: "run-1:step-2",
      step_key: "b",
      ordinal: 2,
      status: "running",
      output_snapshot: null,
    });

    let recomputedA = 0;
    const steps: RoutineStep<Outputs>[] = [
      {
        key: "a",
        run: async () => {
          recomputedA += 1;
          return { value: 100 };
        },
      },
      {
        key: "b",
        run: async ({ outputs }) => ({ value: (outputs.a?.value ?? 0) + 3 }),
      },
      {
        key: "c",
        run: async ({ outputs }) => ({ sum: (outputs.a?.value ?? 0) + (outputs.b?.value ?? 0) }),
      },
    ];

    const result = await resumeRoutine({
      store,
      userId: "user-1",
      run: store.runs.get("run-1") as RoutineRunForResume,
      steps,
      buildRunOutput: buildOutput,
    });

    expect(recomputedA).toBe(0);
    expect(result.status).toBe("completed");
    if (result.status === "waiting_for_approval") throw new Error("unexpected pause");
    expect(result.output).toEqual({ total: 7 });
    expect(store.runs.get("run-1")?.status).toBe("completed");
    expect(store.steps.map((step) => [step.step_key, step.status])).toEqual([
      ["a", "succeeded"],
      ["b", "succeeded"],
      ["c", "succeeded"],
    ]);
  });

  it("rejects a second resume claim when a stale waiting snapshot loses the compare-and-set", async () => {
    const store = new MemoryRoutineStore();
    const waitingSnapshot: RoutineRunForResume = {
      id: "run-1",
      routine_key: "test",
      routine_version: 1,
      status: "waiting_for_approval",
      input_snapshot: {},
      paused_step_key: "b",
      approval_id: "approval-1",
      idempotency_key: "idem-1",
    };
    store.seedRun({ ...waitingSnapshot, status: "running" });

    await expect(resumeRoutine({
      store,
      userId: "user-1",
      run: waitingSnapshot,
      steps: [{ key: "b", run: async () => ({ value: 1 }) }],
      buildRunOutput: buildOutput,
    })).rejects.toMatchObject({ message: "RUN_ALREADY_RESUMING" });
  });

  it("accepts an externally fenced claim without running a second claim", async () => {
    const store = new MemoryRoutineStore();
    const run: RoutineRunForResume = {
      id: "run-1",
      routine_key: "test",
      routine_version: 1,
      status: "waiting_for_approval",
      input_snapshot: {},
      paused_step_key: "b",
      approval_id: "approval-1",
      idempotency_key: "idem-1",
      resume_claim_token: "claim-1",
    };
    store.seedRun({ ...run, status: "running" });

    const result = await resumeRoutine({
      store,
      userId: "user-1",
      run,
      preclaimed: true,
      steps: [{ key: "b", run: async () => ({ value: 1 }) }],
      buildRunOutput: () => ({ total: 1 }),
    });

    expect(result.status).toBe("completed");
    expect(store.runs.get("run-1")?.status).toBe("completed");
  });

  it("stops before the resumed side effect when the claim renewal is lost", async () => {
    const store = new MemoryRoutineStore();
    const run: RoutineRunForResume = {
      id: "run-1",
      routine_key: "test",
      routine_version: 1,
      status: "waiting_for_approval",
      input_snapshot: {},
      paused_step_key: "b",
      approval_id: "approval-1",
      idempotency_key: "idem-1",
      resume_claim_token: "claim-1",
    };
    store.seedRun({ ...run, status: "running" });
    vi.spyOn(store, "renewRunClaim").mockRejectedValue(
      new Error("RUN_RESUME_CLAIM_LOST"),
    );
    const sideEffect = vi.fn(async () => ({ value: 1 }));

    await expect(resumeRoutine({
      store,
      userId: "user-1",
      run,
      preclaimed: true,
      steps: [{ key: "b", run: sideEffect }],
      buildRunOutput: () => ({ total: 1 }),
    })).rejects.toThrow("RUN_RESUME_CLAIM_LOST");
    expect(sideEffect).not.toHaveBeenCalled();
  });

  it("does not treat an already-running blocked-run continuation as claimable", async () => {
    const store = new MemoryRoutineStore();
    const run: RoutineRunForResume = {
      id: "run-1",
      routine_key: "test",
      routine_version: 1,
      status: "running",
      input_snapshot: {},
      paused_step_key: null,
      approval_id: null,
      idempotency_key: null,
    };
    store.seedRun(run);

    await expect(continueRoutineRun({
      store,
      userId: "user-1",
      run,
      steps: [{ key: "a", run: async () => ({ value: 1 }) }],
      buildRunOutput: buildOutput,
    })).rejects.toMatchObject({ message: "RUN_ALREADY_RESUMING" });
  });

  it("quarantines a stale-claim run from the generic blocked-run continuation", async () => {
    const store = new MemoryRoutineStore();
    const run: RoutineRunForResume = {
      id: "run-1",
      routine_key: "test",
      routine_version: 1,
      status: "blocked",
      input_snapshot: {},
      paused_step_key: "b",
      approval_id: "approval-1",
      idempotency_key: "idem-1",
      error: "STALE_RESUME_CLAIM_REQUIRES_REVIEW",
      resume_claim_token: null,
      resume_claim_expires_at: null,
    };
    store.seedRun(run);
    const claim = vi.spyOn(store, "markRunRunning");
    const sideEffect = vi.fn(async () => ({ value: 1 }));

    await expect(continueRoutineRun({
      store,
      userId: "user-1",
      run,
      steps: [{ key: "b", run: sideEffect }],
      buildRunOutput: buildOutput,
    })).rejects.toMatchObject({ message: "RUN_REQUIRES_REVIEW" });

    expect(claim).not.toHaveBeenCalled();
    expect(sideEffect).not.toHaveBeenCalled();
    expect(store.runs.get("run-1")?.status).toBe("blocked");
  });

  it("continues an ordinary blocked run with no approval or claim metadata", async () => {
    const store = new MemoryRoutineStore();
    const run: RoutineRunForResume = {
      id: "run-1",
      routine_key: "test",
      routine_version: 1,
      status: "blocked",
      input_snapshot: {},
      paused_step_key: null,
      approval_id: null,
      idempotency_key: null,
      error: "TRANSIENT_PROVIDER_FAILURE",
      resume_claim_token: null,
      resume_claim_expires_at: null,
    };
    store.seedRun(run);

    const result = await continueRoutineRun({
      store,
      userId: "user-1",
      run,
      steps: [{ key: "a", run: async () => ({ value: 1 }) }],
      buildRunOutput: buildOutput,
    });

    expect(result.status).toBe("completed");
    expect(store.runs.get("run-1")?.status).toBe("completed");
  });

  it("recovers a committed repause when the RPC response is lost", async () => {
    const query: Record<string, unknown> = {};
    query.select = vi.fn(() => query);
    query.eq = vi.fn(() => query);
    query.maybeSingle = vi.fn(async () => ({
      data: {
        status: "waiting_for_approval",
        approval_id: "approval-2",
        paused_step_key: "b",
        idempotency_key: "idem-2",
        resume_claim_token: null,
      },
      error: null,
    }));
    const client = {
      rpc: vi.fn(async () => ({ data: null, error: new Error("connection reset") })),
      from: vi.fn(() => query),
    } as unknown as Parameters<typeof createSupabaseRoutineStore>[0];
    const store = createSupabaseRoutineStore(client, {
      resumeApprovalClaim: {
        userId: "user-1",
        approvalId: "approval-1",
        claimToken: "claim-1",
      },
    });

    await expect(store.markRunWaitingForApproval({
      runId: "run-1",
      userId: "user-1",
      pausedStepKey: "b",
      approvalId: "approval-2",
      idempotencyKey: "idem-2",
    })).resolves.toBeUndefined();
  });

  it("recovers a committed step completion when the update response is lost", async () => {
    const update = awaitedQuery({ data: null, error: new Error("connection reset") });
    const recovery = awaitedQuery({ data: { status: "succeeded" }, error: null });
    const client = {
      from: vi.fn()
        .mockReturnValueOnce(update)
        .mockReturnValueOnce(recovery),
    } as unknown as Parameters<typeof createSupabaseRoutineStore>[0];
    const store = createSupabaseRoutineStore(client);

    await expect(store.completeStep({
      stepRunId: "step-1",
      runId: "run-1",
      userId: "user-1",
      outputSnapshot: { value: 1 },
    })).resolves.toBeUndefined();
  });

  it("recovers a committed terminal run when the update response is lost", async () => {
    const update = awaitedQuery({ data: null, error: new Error("connection reset") });
    const recovery = awaitedQuery({
      data: { status: "completed", completed_at: "2026-07-16T12:00:00.000Z" },
      error: null,
    });
    const client = {
      from: vi.fn()
        .mockReturnValueOnce(update)
        .mockReturnValueOnce(recovery),
    } as unknown as Parameters<typeof createSupabaseRoutineStore>[0];
    const store = createSupabaseRoutineStore(client);

    await expect(store.completeRun({
      runId: "run-1",
      userId: "user-1",
      status: "completed",
      output: { total: 1 },
      actualCostUsd: 0,
    })).resolves.toBeUndefined();
  });

  it("routes every resumed step mutation through claim-fenced RPCs", async () => {
    const rpc = vi.fn(async (
      name: string,
      _args?: Record<string, unknown>,
    ) => {
      void _args;
      if (name === "renew_routine_approval_resume") {
        return { data: true, error: null };
      }
      if (name === "start_routine_step_under_claim") {
        return { data: { id: "step-1", ordinal: 2 }, error: null };
      }
      return { data: true, error: null };
    });
    const client = { rpc } as unknown as Parameters<typeof createSupabaseRoutineStore>[0];
    const store = createSupabaseRoutineStore(client, {
      resumeApprovalClaim: {
        userId: "user-1",
        approvalId: "approval-1",
        claimToken: "claim-1",
      },
    });

    await store.renewRunClaim("run-1", "user-1");
    await expect(store.startStep({
      runId: "run-1",
      userId: "user-1",
      stepKey: "b",
      ordinal: 2,
      inputSnapshot: { input: true },
    })).resolves.toEqual({ id: "step-1", ordinal: 2 });
    await store.completeStep({
      stepRunId: "step-1",
      runId: "run-1",
      userId: "user-1",
      outputSnapshot: { value: 1 },
    });
    await store.failStep({
      stepRunId: "step-2",
      runId: "run-1",
      userId: "user-1",
      error: "SAFE_FAILURE",
    });

    expect(rpc.mock.calls.map(([name]) => name)).toEqual([
      "renew_routine_approval_resume",
      "start_routine_step_under_claim",
      "complete_routine_step_under_claim",
      "fail_routine_step_under_claim",
    ]);
    for (const [, args] of rpc.mock.calls) {
      expect(args).toMatchObject({
        p_user_id: "user-1",
        p_run_id: "run-1",
        p_approval_id: "approval-1",
        p_claim_token: "claim-1",
      });
    }
  });
});
