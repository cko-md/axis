import { describe, expect, it, vi } from "vitest";
import {
  bindVectorPointerCapture,
  classifyVectorRuntimeFailure,
  VectorRuntimeController,
  VectorRuntimeStateError,
  clampVectorAutosaveInterval,
  createFixedStepClock,
  createVectorRuntimeFinalizationBarrier,
  createVectorRuntimeScheduler,
  getVectorRuntimeUnsupportedReason,
  isVectorRuntimeCheckpointable,
  resolveVectorPointerCaptureOwner,
  resolveVectorMotionPreference,
  sanitizeVectorRuntimeEvent,
  supportsVectorFullscreen,
  teardownVectorRuntime,
} from "@/lib/vector/runtime";
import type {
  VectorGameInstance,
  VectorRuntimeState,
  VectorRuntimeSettings,
  VectorSerializedSave,
} from "@/lib/vector/types";

function fakeGame() {
  const save: VectorSerializedSave = { schemaVersion: 1, data: { checkpoint: 2 } };
  const instance: VectorGameInstance = {
    initialize: vi.fn(async () => undefined),
    hydrate: vi.fn(async () => undefined),
    start: vi.fn(async () => undefined),
    pause: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    serialize: vi.fn(async () => save),
    reset: vi.fn(async () => undefined),
    updateSettings: vi.fn(async () => undefined),
    handleContextLoss: vi.fn(async () => undefined),
    handleContextRestore: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
  };
  return { instance, save };
}

describe("VECTOR runtime helpers", () => {
  it("resolves explicit motion preferences ahead of the operating system", () => {
    expect(resolveVectorMotionPreference("system", true)).toBe("reduced");
    expect(resolveVectorMotionPreference("system", false)).toBe("standard");
    expect(resolveVectorMotionPreference("standard", true)).toBe("standard");
    expect(resolveVectorMotionPreference("reduced", false)).toBe("reduced");
  });

  it("uses a fixed step, clamps elapsed time, and drops runaway catch-up work", () => {
    const clock = createFixedStepClock({
      targetFrameRate: 60,
      maxFrameDeltaMs: 250,
      maxStepsPerTick: 4,
    });

    expect(clock.tick(1000)).toMatchObject({ steps: 0, elapsedMs: 0 });
    const normal = clock.tick(1017);
    expect(normal.steps).toBe(1);
    expect(normal.droppedMs).toBe(0);

    const clamped = clock.tick(2000);
    expect(clamped.elapsedMs).toBe(250);
    expect(clamped.steps).toBe(4);
    expect(clamped.droppedMs).toBeGreaterThan(0);
    expect(clamped.alpha).toBeGreaterThanOrEqual(0);
    expect(clamped.alpha).toBeLessThanOrEqual(1);
  });

  it("keeps autosave cadence inside the platform bounds", () => {
    expect(clampVectorAutosaveInterval(Number.NaN)).toBe(30_000);
    expect(clampVectorAutosaveInterval(1)).toBe(10_000);
    expect(clampVectorAutosaveInterval(45_000.4)).toBe(45_000);
    expect(clampVectorAutosaveInterval(500_000)).toBe(120_000);
  });

  it("owns a bounded fixed-step scheduler and releases its frame on stop", () => {
    const frames = new Map<number, FrameRequestCallback>();
    const cancelled: number[] = [];
    let nextHandle = 1;
    const scheduler = createVectorRuntimeScheduler({
      targetFrameRate: 60,
      requestFrame(callback) {
        const handle = nextHandle++;
        frames.set(handle, callback);
        return handle;
      },
      cancelFrame(handle) {
        cancelled.push(handle);
        frames.delete(handle);
      },
    });
    const listener = vi.fn();
    scheduler.subscribe(listener);

    scheduler.start();
    expect(scheduler.isRunning()).toBe(true);
    const first = frames.get(1);
    frames.delete(1);
    first?.(1000);
    const second = frames.get(2);
    frames.delete(2);
    second?.(1017);

    expect(listener).toHaveBeenNthCalledWith(1, expect.objectContaining({
      nowMs: 1000,
      steps: 0,
    }));
    expect(listener).toHaveBeenNthCalledWith(2, expect.objectContaining({
      nowMs: 1017,
      steps: 1,
    }));
    scheduler.stop();
    expect(scheduler.isRunning()).toBe(false);
    expect(cancelled).toContain(3);
    scheduler.dispose();
    expect(() => scheduler.subscribe(() => undefined))
      .toThrow("VECTOR_SCHEDULER_DISPOSED");
  });

  it("rejects undersized or incorrectly oriented viewports before runtime boot", () => {
    expect(getVectorRuntimeUnsupportedReason({
      minimumViewport: { width: 800, height: 600 },
      orientation: "any",
      viewport: { width: 799, height: 600 },
    })).toMatch(/at least 800 × 600/);
    expect(getVectorRuntimeUnsupportedReason({
      minimumViewport: { width: 600, height: 600 },
      orientation: "landscape",
      viewport: { width: 700, height: 900 },
    })).toMatch(/landscape orientation/);
    expect(getVectorRuntimeUnsupportedReason({
      minimumViewport: { width: 600, height: 600 },
      orientation: "portrait",
      viewport: { width: 900, height: 700 },
    })).toMatch(/portrait orientation/);
    expect(getVectorRuntimeUnsupportedReason({
      minimumViewport: { width: 600, height: 600 },
      orientation: "landscape",
      viewport: { width: 900, height: 700 },
    })).toBeNull();
  });

  it("requires the complete browser fullscreen contract", () => {
    expect(supportsVectorFullscreen(
      { fullscreenEnabled: true, exitFullscreen: () => undefined },
      { requestFullscreen: () => undefined },
    )).toBe(true);
    expect(supportsVectorFullscreen(
      { fullscreenEnabled: false, exitFullscreen: () => undefined },
      { requestFullscreen: () => undefined },
    )).toBe(false);
    expect(supportsVectorFullscreen(
      { fullscreenEnabled: true, exitFullscreen: () => undefined },
      null,
    )).toBe(false);
  });

  it("captures pointers to the play surface and releases cancel/teardown ownership", () => {
    class FakePointerTarget extends EventTarget {
      readonly captured = new Set<number>();

      setPointerCapture(pointerId: number) {
        this.captured.add(pointerId);
      }

      hasPointerCapture(pointerId: number) {
        return this.captured.has(pointerId);
      }

      releasePointerCapture(pointerId: number) {
        this.captured.delete(pointerId);
      }
    }
    const target = new FakePointerTarget();
    const pointerEvent = (type: string, pointerId: number) => {
      const event = new Event(type);
      Object.defineProperty(event, "pointerId", { value: pointerId });
      return event;
    };
    const unbind = bindVectorPointerCapture(target as unknown as HTMLElement);

    target.dispatchEvent(pointerEvent("pointerdown", 7));
    expect(target.captured).toEqual(new Set([7]));
    target.dispatchEvent(pointerEvent("pointercancel", 7));
    expect(target.captured).toEqual(new Set());
    target.dispatchEvent(pointerEvent("pointerdown", 8));
    unbind();
    expect(target.captured).toEqual(new Set());
  });

  it("keeps child play-surface pointer capture on the originating element", () => {
    class FakePointerTarget extends EventTarget {
      readonly captured = new Set<number>();

      setPointerCapture(pointerId: number) {
        this.captured.add(pointerId);
      }

      hasPointerCapture(pointerId: number) {
        return this.captured.has(pointerId);
      }

      releasePointerCapture(pointerId: number) {
        this.captured.delete(pointerId);
      }
    }
    const wrapper = new FakePointerTarget();
    const canvas = new FakePointerTarget();

    expect(resolveVectorPointerCaptureOwner(
      wrapper as unknown as HTMLElement,
      canvas,
    )).toBe(canvas);
  });

  it("allows checkpoints only from initialized non-error runtime states", () => {
    expect([
      "idle",
      "initializing",
      "ready",
      "running",
      "paused",
      "suspended",
      "error",
      "disposed",
    ].map((state) => [state, isVectorRuntimeCheckpointable(state as VectorRuntimeState)]))
      .toEqual([
        ["idle", false],
        ["initializing", false],
        ["ready", true],
        ["running", true],
        ["paused", true],
        ["suspended", true],
        ["error", false],
        ["disposed", false],
      ]);
  });

  it("retains the owner-transition barrier until final teardown settles", async () => {
    let releaseCheckpoint: (() => void) | undefined;
    let releaseFinalization: (() => void) | undefined;
    const calls: string[] = [];
    const barrier = createVectorRuntimeFinalizationBarrier({
      checkpoint: async () => {
        calls.push("checkpoint:start");
        await new Promise<void>((resolve) => {
          releaseCheckpoint = resolve;
        });
        calls.push("checkpoint:end");
        return true;
      },
      finalize: async (needsCheckpoint) => {
        calls.push(`finalize:${needsCheckpoint}`);
        await new Promise<void>((resolve) => {
          releaseFinalization = resolve;
        });
      },
      release: () => calls.push("release"),
    });

    const transition = barrier.checkpointForOwnerTransition();
    await Promise.resolve();
    const finalization = barrier.finalize();
    expect(barrier.checkpointForOwnerTransition()).toBe(finalization);
    expect(calls).toEqual(["checkpoint:start"]);

    releaseCheckpoint?.();
    await transition;
    await Promise.resolve();
    expect(calls).toEqual([
      "checkpoint:start",
      "checkpoint:end",
      "finalize:false",
    ]);

    releaseFinalization?.();
    await finalization;
    expect(calls.at(-1)).toBe("release");
  });

  it("retries the route-exit checkpoint during teardown after a barrier failure", async () => {
    const calls: string[] = [];
    const barrier = createVectorRuntimeFinalizationBarrier({
      checkpoint: async () => {
        calls.push("checkpoint");
        throw new Error("fixed test failure");
      },
      finalize: async (needsCheckpoint) => {
        calls.push(`finalize:${needsCheckpoint}`);
      },
      release: () => calls.push("release"),
    });

    await expect(barrier.checkpointForOwnerTransition()).rejects.toThrow(
      "fixed test failure",
    );
    await barrier.finalize();
    expect(calls).toEqual(["checkpoint", "finalize:true", "release"]);
  });

  it("accepts only bounded content-free runtime event envelopes", () => {
    const occurredAt = "2026-07-16T12:00:00.000Z";
    expect(sanitizeVectorRuntimeEvent({
      type: "level.complete",
      occurredAt,
      metadata: {
        level: 2,
        perfect: true,
        mode: "daily",
        achievementId: null,
      },
    })).toEqual({
      type: "level.complete",
      occurredAt,
      metadata: {
        level: 2,
        perfect: true,
        mode: "daily",
        achievementId: null,
      },
    });
    expect(sanitizeVectorRuntimeEvent({
      type: "../private",
      occurredAt,
    })).toBeNull();
    expect(sanitizeVectorRuntimeEvent({
      type: "private.identifier",
      occurredAt,
    })).toBeNull();
    expect(sanitizeVectorRuntimeEvent({
      type: "level.complete",
      occurredAt: "not-a-date",
    })).toBeNull();
    expect(sanitizeVectorRuntimeEvent({
      type: "level.complete",
      occurredAt,
      metadata: { score: Number.POSITIVE_INFINITY },
    })).toBeNull();
    expect(sanitizeVectorRuntimeEvent({
      type: "level.complete",
      occurredAt,
      metadata: { private_state: "x".repeat(257) },
    })).toBeNull();
    expect(sanitizeVectorRuntimeEvent({
      type: "level.complete",
      occurredAt,
      metadata: { mode: "customer-secret-identifier" },
    })).toBeNull();
    expect(sanitizeVectorRuntimeEvent({
      type: "level.complete",
      occurredAt,
      metadata: { achievementId: "personally-identifying-value" },
    })).toBeNull();
  });

  it("records expected persistence conflicts without escalating private engine errors", () => {
    expect(classifyVectorRuntimeFailure(
      new Error("VECTOR_SAVE_CONFLICT_CREATED"),
    )).toEqual({
      code: "VECTOR_SAVE_CONFLICT_CREATED",
      status: 409,
      expected: true,
    });
    expect(classifyVectorRuntimeFailure(
      new Error("private provider payload"),
    )).toEqual({
      code: "VECTOR_RUNTIME_FAILED",
      status: 500,
      expected: false,
    });
  });
});

describe("VectorRuntimeController", () => {
  it("persists the route-exit checkpoint before disposing the game", async () => {
    const { instance, save } = fakeGame();
    const calls: string[] = [];
    const onSave = vi.fn(async () => {
      calls.push("save");
    });
    vi.mocked(instance.dispose).mockImplementationOnce(async () => {
      calls.push("dispose");
    });
    const controller = new VectorRuntimeController(instance, { onSave });

    await controller.initialize();
    await controller.start();
    await teardownVectorRuntime(controller);

    expect(onSave).toHaveBeenCalledWith(save, "route-exit");
    expect(calls).toEqual(["save", "dispose"]);
    expect(controller.getState()).toBe("disposed");
  });

  it("hydrates before start, saves on pause, resumes, restarts, and disposes once", async () => {
    const { instance, save } = fakeGame();
    const onSave = vi.fn(async () => undefined);
    const states: string[] = [];
    const controller = new VectorRuntimeController(instance, {
      onSave,
      onStateChange: (state) => states.push(state),
    });

    await controller.initialize(save);
    await controller.start();
    await controller.pause("user");
    await controller.resume();
    await controller.restart();
    await controller.dispose();
    await controller.dispose();

    expect(instance.initialize).toHaveBeenCalledTimes(1);
    expect(instance.hydrate).toHaveBeenCalledWith(save);
    expect(instance.start).toHaveBeenCalledTimes(2);
    expect(instance.pause).toHaveBeenNthCalledWith(1, "user");
    expect(instance.pause).toHaveBeenNthCalledWith(2, "system");
    expect(instance.resume).toHaveBeenCalledTimes(1);
    expect(instance.reset).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenNthCalledWith(1, save, "pause");
    expect(onSave).toHaveBeenNthCalledWith(2, save, "restart");
    expect(instance.dispose).toHaveBeenCalledTimes(1);
    expect(controller.getState()).toBe("disposed");
    expect(states).toEqual([
      "initializing",
      "ready",
      "running",
      "paused",
      "running",
      "disposed",
    ]);
  });

  it("serializes visibility suspension and queued resume in order", async () => {
    const { instance, save } = fakeGame();
    const onSave = vi.fn(async () => undefined);
    const controller = new VectorRuntimeController(instance, { onSave });

    await controller.initialize();
    await controller.start();
    const suspend = controller.suspend();
    const resume = controller.resume();
    await Promise.all([suspend, resume]);

    expect(instance.pause).toHaveBeenCalledWith("visibility");
    expect(onSave).toHaveBeenCalledWith(save, "visibility");
    expect(instance.resume).toHaveBeenCalledTimes(1);
    expect(controller.getState()).toBe("running");
  });

  it("uses the pagehide save reason while suspending the running engine", async () => {
    const { instance, save } = fakeGame();
    const onSave = vi.fn(async () => undefined);
    const controller = new VectorRuntimeController(instance, { onSave });

    await controller.initialize();
    await controller.start();
    await controller.suspend("pagehide");

    expect(instance.pause).toHaveBeenCalledWith("visibility");
    expect(onSave).toHaveBeenCalledWith(save, "pagehide");
    expect(controller.getState()).toBe("suspended");
  });

  it("passes settings to the engine and rejects invalid transitions visibly", async () => {
    const { instance } = fakeGame();
    const onError = vi.fn();
    const controller = new VectorRuntimeController(instance, { onError });
    const settings: VectorRuntimeSettings = {
      motionPreference: "reduced",
      resolvedMotion: "reduced",
      muted: true,
      volume: 0,
      lowPower: true,
    };

    await controller.initialize();
    await controller.updateSettings(settings);
    await expect(controller.resume()).rejects.toBeInstanceOf(VectorRuntimeStateError);

    expect(instance.updateSettings).toHaveBeenCalledWith(settings);
    expect(onError).toHaveBeenCalledWith(expect.any(VectorRuntimeStateError), "resume");
    expect(controller.getState()).toBe("error");
  });

  it("suspends for graphics-context loss and delegates restoration without auto-resuming", async () => {
    const { instance } = fakeGame();
    const controller = new VectorRuntimeController(instance);

    await controller.initialize();
    await controller.start();
    await controller.handleContextLoss();
    await controller.handleContextRestore();

    expect(instance.pause).toHaveBeenCalledWith("system");
    expect(instance.handleContextLoss).toHaveBeenCalledTimes(1);
    expect(instance.handleContextRestore).toHaveBeenCalledTimes(1);
    expect(controller.getState()).toBe("suspended");
  });

  it("enters error state and reports engine failures without swallowing them", async () => {
    const { instance } = fakeGame();
    const failure = new Error("engine start failed");
    vi.mocked(instance.start).mockRejectedValueOnce(failure);
    const onSave = vi.fn(async () => undefined);
    const onError = vi.fn();
    const controller = new VectorRuntimeController(instance, { onError, onSave });

    await controller.initialize();
    await expect(controller.start()).rejects.toThrow("engine start failed");
    await expect(controller.checkpoint("route-exit")).resolves.toBeNull();

    expect(controller.getState()).toBe("error");
    expect(onError).toHaveBeenCalledWith(failure, "start");
    expect(instance.serialize).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
    await controller.dispose();
    expect(controller.getState()).toBe("disposed");
  });

  it("marks disposed immediately but waits for in-flight work before releasing resources", async () => {
    const { instance, save } = fakeGame();
    let finishSerialize: ((value: VectorSerializedSave) => void) | undefined;
    vi.mocked(instance.serialize).mockImplementationOnce(() => new Promise((resolve) => {
      finishSerialize = resolve;
    }));
    const onSave = vi.fn(async () => undefined);
    const states: string[] = [];
    const controller = new VectorRuntimeController(instance, {
      onSave,
      onStateChange: (state) => states.push(state),
    });

    await controller.initialize();
    await controller.start();
    const checkpoint = controller.checkpoint("autosave");
    await vi.waitFor(() => expect(instance.serialize).toHaveBeenCalledTimes(1));

    const dispose = controller.dispose();
    expect(controller.getState()).toBe("disposed");
    expect(instance.dispose).not.toHaveBeenCalled();

    finishSerialize?.(save);
    await expect(checkpoint).resolves.toBeNull();
    await dispose;
    await controller.dispose();

    expect(onSave).not.toHaveBeenCalled();
    expect(instance.dispose).toHaveBeenCalledTimes(1);
    expect(states.at(-1)).toBe("disposed");
  });

  it("does not dispose engine resources underneath delayed initialization", async () => {
    const { instance } = fakeGame();
    let finishInitialize: (() => void) | undefined;
    vi.mocked(instance.initialize).mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishInitialize = resolve;
    }));
    const controller = new VectorRuntimeController(instance);

    const initialize = controller.initialize();
    await vi.waitFor(() => expect(instance.initialize).toHaveBeenCalledTimes(1));
    const dispose = controller.dispose();

    expect(controller.getState()).toBe("disposed");
    expect(instance.dispose).not.toHaveBeenCalled();
    finishInitialize?.();
    await expect(initialize).resolves.toBeUndefined();
    await dispose;

    expect(instance.hydrate).not.toHaveBeenCalled();
    expect(instance.dispose).toHaveBeenCalledTimes(1);
  });
});
