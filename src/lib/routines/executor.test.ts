import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Json } from "@/lib/supabase/database.types";

const mocks = vi.hoisted(() => ({
  captureRouteError: vi.fn(),
}));

vi.mock("@/lib/observability/captureRouteError", () => ({
  captureRouteError: (...args: unknown[]) => mocks.captureRouteError(...args),
}));

import {
  executeRoutine,
  pauseForApproval,
  resumeRoutine,
  RoutineExecutionError,
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
  resumeMode?: "claimed";
  runs = new Map<string, RoutineRunForResume & { output?: Json | null; error?: string | null }>();
  steps: RoutineStepRunSnapshot[] = [];
  nextRun = 1;
  nextStep = 1;
  renewals = 0;
  starts: string[] = [];
  failStepError: Error | null = null;
  failRunError: Error | null = null;

  constructor(claimed = false) {
    if (claimed) this.resumeMode = "claimed";
  }

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
    this.starts.push(input.stepKey);
    const existing = this.steps.find(
      (step) => step.id.startsWith(`${input.runId}:`)
        && step.step_key === input.stepKey
        && step.status === "running",
    );
    if (existing) {
      return {
        id: existing.id,
        ordinal: existing.ordinal,
        status: "running" as const,
        outputSnapshot: existing.output_snapshot,
      };
    }
    const id = `${input.runId}:step-${this.nextStep++}`;
    this.steps.push({
      id,
      step_key: input.stepKey,
      ordinal: input.ordinal,
      status: "running",
      output_snapshot: null,
    });
    return {
      id,
      ordinal: input.ordinal,
      status: "running" as const,
      outputSnapshot: null,
    };
  }

  async completeStep(input: Parameters<RoutineExecutionStore["completeStep"]>[0]) {
    const step = this.requireStep(input.stepRunId);
    step.status = "succeeded";
    step.output_snapshot = input.outputSnapshot;
  }

  async failStep(input: Parameters<RoutineExecutionStore["failStep"]>[0]) {
    if (this.failStepError) throw this.failStepError;
    this.requireStep(input.stepRunId).status = "failed";
  }

  async renewRunClaim() {
    this.renewals += 1;
  }

  async markRunRunning(runId: string) {
    this.requireRun(runId).status = "running";
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
    if (this.failRunError) throw this.failRunError;
    const run = this.requireRun(input.runId);
    if (this.resumeMode === "claimed") {
      run.status = "waiting_for_approval";
      run.error = input.error;
      return;
    }
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

describe("routine executor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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

  it("passes the persisted resume idempotency key to side effects and renews the claim", async () => {
    const store = new MemoryRoutineStore(true);
    store.seedRun({
      id: "run-1",
      routine_key: "test",
      routine_version: 1,
      status: "running",
      input_snapshot: {},
      paused_step_key: "b",
      approval_id: "approval-1",
      idempotency_key: "stored-idempotency-key",
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

    const observedKeys: Array<string | null> = [];
    const result = await resumeRoutine({
      store,
      userId: "user-1",
      run: store.runs.get("run-1") as RoutineRunForResume,
      steps: [
        { key: "a", run: async () => ({ value: 100 }) },
        {
          key: "b",
          run: async ({ idempotencyKey }) => {
            observedKeys.push(idempotencyKey);
            return { value: 5 };
          },
        },
        {
          key: "c",
          run: async ({ outputs, idempotencyKey }) => {
            observedKeys.push(idempotencyKey);
            return { sum: (outputs.a?.value ?? 0) + (outputs.b?.value ?? 0) };
          },
        },
      ],
      buildRunOutput: buildOutput,
    });

    expect(result.status).toBe("completed");
    expect(observedKeys).toEqual([
      "stored-idempotency-key",
      "routine-resume:run-1:c",
    ]);
    expect(store.starts).toContain("b");
    expect(store.renewals).toBeGreaterThanOrEqual(5);
  });

  it("releases a failed claimed resume back to approval waiting without losing pause metadata", async () => {
    const store = new MemoryRoutineStore(true);
    store.seedRun({
      id: "run-1",
      routine_key: "test",
      routine_version: 1,
      status: "running",
      input_snapshot: {},
      paused_step_key: "b",
      approval_id: "approval-1",
      idempotency_key: "idem-1",
    });
    store.seedStep({
      id: "run-1:step-2",
      step_key: "b",
      ordinal: 2,
      status: "running",
      output_snapshot: null,
    });

    await expect(resumeRoutine({
      store,
      userId: "user-1",
      run: store.runs.get("run-1") as RoutineRunForResume,
      steps: [
        { key: "a", run: async () => ({ value: 1 }) },
        { key: "b", run: async () => { throw new Error("SIDE_EFFECT_FAILED"); } },
        { key: "c", run: async () => ({ sum: 0 }) },
      ],
      buildRunOutput: buildOutput,
      failureStatus: "blocked",
    })).rejects.toEqual(expect.objectContaining({
      name: "RoutineExecutionError",
      message: "SIDE_EFFECT_FAILED",
    }));

    expect(store.runs.get("run-1")).toMatchObject({
      status: "waiting_for_approval",
      paused_step_key: "b",
      approval_id: "approval-1",
      idempotency_key: "idem-1",
      error: "SIDE_EFFECT_FAILED",
    });
    expect(store.steps.find((step) => step.step_key === "b")?.status).toBe("failed");
  });

  it("captures safe persistence failures instead of silently swallowing them", async () => {
    const store = new MemoryRoutineStore(true);
    store.failStepError = new Error("STEP_FAIL_RECORD_FAILED");
    store.failRunError = new Error("RUN_RELEASE_FAILED");
    store.seedRun({
      id: "run-1",
      routine_key: "test",
      routine_version: 1,
      status: "running",
      input_snapshot: {},
      paused_step_key: "b",
      approval_id: "approval-1",
      idempotency_key: "idem-1",
    });
    store.seedStep({
      id: "run-1:step-2",
      step_key: "b",
      ordinal: 2,
      status: "running",
      output_snapshot: null,
    });

    await expect(resumeRoutine({
      store,
      userId: "user-1",
      run: store.runs.get("run-1") as RoutineRunForResume,
      steps: [
        { key: "a", run: async () => ({ value: 1 }) },
        { key: "b", run: async () => { throw new Error("SIDE_EFFECT_FAILED"); } },
        { key: "c", run: async () => ({ sum: 0 }) },
      ],
      buildRunOutput: buildOutput,
    })).rejects.toBeInstanceOf(RoutineExecutionError);

    expect(mocks.captureRouteError).toHaveBeenCalledTimes(2);
    expect(mocks.captureRouteError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        operation: "record_step_failure",
        code: "STEP_FAIL_RECORD_FAILED",
        tags: expect.objectContaining({ runId: "run-1", claimedResume: true }),
      }),
    );
    expect(mocks.captureRouteError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        operation: "record_run_failure",
        code: "RUN_RELEASE_FAILED",
      }),
    );
  });
});
