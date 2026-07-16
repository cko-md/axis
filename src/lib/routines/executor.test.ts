import { describe, expect, it } from "vitest";
import type { Json } from "@/lib/supabase/database.types";
import {
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

  async markRunRunning(runId: string) {
    const run = this.requireRun(runId);
    if (run.status !== "waiting_for_approval") return false;
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

  it("rejects a second resume claim before rerunning a paused step", async () => {
    const store = new MemoryRoutineStore();
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

    await expect(resumeRoutine({
      store,
      userId: "user-1",
      run: store.runs.get("run-1") as RoutineRunForResume,
      steps: [{ key: "b", run: async () => ({ value: 1 }) }],
      buildRunOutput: buildOutput,
    })).rejects.toMatchObject({ message: "RUN_NOT_WAITING_FOR_APPROVAL" });
  });
});
