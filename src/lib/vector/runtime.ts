import type {
  VectorGameOrientation,
  VectorGameInstance,
  VectorMotionPreference,
  VectorPauseReason,
  VectorRuntimeFrame,
  VectorRuntimeEvent,
  VectorRuntimeScheduler,
  VectorResolvedMotion,
  VectorRuntimeSettings,
  VectorRuntimeState,
  VectorSaveReason,
  VectorSerializedSave,
} from "@/lib/vector/types";

export function resolveVectorMotionPreference(
  preference: VectorMotionPreference,
  systemPrefersReducedMotion: boolean,
): VectorResolvedMotion {
  if (preference === "reduced") return "reduced";
  if (preference === "standard") return "standard";
  return systemPrefersReducedMotion ? "reduced" : "standard";
}

export const DEFAULT_VECTOR_AUTOSAVE_INTERVAL_MS = 30_000;
export const MIN_VECTOR_AUTOSAVE_INTERVAL_MS = 10_000;
export const MAX_VECTOR_AUTOSAVE_INTERVAL_MS = 120_000;

export function clampVectorAutosaveInterval(intervalMs: number) {
  if (!Number.isFinite(intervalMs)) return DEFAULT_VECTOR_AUTOSAVE_INTERVAL_MS;
  return Math.min(
    MAX_VECTOR_AUTOSAVE_INTERVAL_MS,
    Math.max(MIN_VECTOR_AUTOSAVE_INTERVAL_MS, Math.round(intervalMs)),
  );
}

export type VectorRuntimeViewport = {
  width: number;
  height: number;
};

export function getVectorRuntimeUnsupportedReason({
  minimumViewport,
  orientation,
  viewport,
}: {
  minimumViewport: VectorRuntimeViewport;
  orientation: VectorGameOrientation;
  viewport: VectorRuntimeViewport;
}): string | null {
  if (
    viewport.width < minimumViewport.width
    || viewport.height < minimumViewport.height
  ) {
    return `This game needs at least ${minimumViewport.width} × ${minimumViewport.height} CSS pixels. The current viewport is ${viewport.width} × ${viewport.height}.`;
  }
  if (orientation === "landscape" && viewport.height > viewport.width) {
    return "This game requires landscape orientation. Rotate the device or widen the window to continue.";
  }
  if (orientation === "portrait" && viewport.width > viewport.height) {
    return "This game requires portrait orientation. Rotate the device or narrow the window to continue.";
  }
  return null;
}

export function supportsVectorFullscreen(
  documentValue: {
    fullscreenEnabled?: boolean;
    exitFullscreen?: unknown;
  },
  target: {
    requestFullscreen?: unknown;
  } | null,
) {
  return (
    documentValue.fullscreenEnabled !== false
    && typeof documentValue.exitFullscreen === "function"
    && typeof target?.requestFullscreen === "function"
  );
}

type VectorPointerCaptureOwner = {
  setPointerCapture: (pointerId: number) => void;
  hasPointerCapture: (pointerId: number) => boolean;
  releasePointerCapture: (pointerId: number) => void;
};

function supportsVectorPointerCapture(
  value: unknown,
): value is EventTarget & VectorPointerCaptureOwner {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<VectorPointerCaptureOwner>;
  return (
    typeof candidate.setPointerCapture === "function"
    && typeof candidate.hasPointerCapture === "function"
    && typeof candidate.releasePointerCapture === "function"
  );
}

export function resolveVectorPointerCaptureOwner(
  target: HTMLElement,
  origin: EventTarget | null,
): VectorPointerCaptureOwner {
  if (!supportsVectorPointerCapture(origin) || origin === target) return target;
  if (typeof target.contains !== "function") return origin;
  if (typeof Node === "undefined" || !(origin instanceof Node)) return target;
  return target.contains(origin) ? origin : target;
}

export function bindVectorPointerCapture(target: HTMLElement) {
  const captured = new Map<number, VectorPointerCaptureOwner>();
  const capture = (event: PointerEvent) => {
    const owner = resolveVectorPointerCaptureOwner(target, event.target);
    try {
      owner.setPointerCapture(event.pointerId);
      captured.set(event.pointerId, owner);
    } catch {
      // Unsupported pointer-capture implementations still receive the
      // original event; games must continue without a false ownership claim.
    }
  };
  const release = (event: PointerEvent) => {
    const owner = captured.get(event.pointerId);
    if (!owner) return;
    captured.delete(event.pointerId);
    try {
      if (owner.hasPointerCapture(event.pointerId)) {
        owner.releasePointerCapture(event.pointerId);
      }
    } catch {
      // The browser may already have released capture during cancellation.
    }
  };
  const lost = (event: PointerEvent) => {
    captured.delete(event.pointerId);
  };
  target.addEventListener("pointerdown", capture);
  target.addEventListener("pointerup", release);
  target.addEventListener("pointercancel", release);
  target.addEventListener("lostpointercapture", lost);
  return () => {
    target.removeEventListener("pointerdown", capture);
    target.removeEventListener("pointerup", release);
    target.removeEventListener("pointercancel", release);
    target.removeEventListener("lostpointercapture", lost);
    for (const [pointerId, owner] of captured) {
      try {
        if (owner.hasPointerCapture(pointerId)) {
          owner.releasePointerCapture(pointerId);
        }
      } catch {
        // Capture can disappear as the element detaches.
      }
    }
    captured.clear();
  };
}

export function isVectorRuntimeCheckpointable(state: VectorRuntimeState) {
  return (
    state === "ready"
    || state === "running"
    || state === "paused"
    || state === "suspended"
  );
}

export function createVectorRuntimeFinalizationBarrier(input: {
  checkpoint: () => boolean | Promise<boolean>;
  finalize: (needsCheckpoint: boolean) => void | Promise<void>;
  release: () => void;
}) {
  let checkpoint: Promise<void> | null = null;
  let checkpointCompleted = false;
  let finalization: Promise<void> | null = null;

  const checkpointForOwnerTransition = () => {
    if (finalization) return finalization;
    if (checkpoint) return checkpoint;
    checkpoint = Promise.resolve()
      .then(input.checkpoint)
      .then((completed) => {
        checkpointCompleted = completed;
      });
    return checkpoint;
  };

  const finalize = () => {
    if (finalization) return finalization;
    const pendingCheckpoint = checkpoint
      ? checkpoint.catch(() => undefined)
      : Promise.resolve();
    finalization = pendingCheckpoint
      .then(() => input.finalize(!checkpointCompleted))
      .finally(input.release);
    return finalization;
  };

  return { checkpointForOwnerTransition, finalize };
}

const EXPECTED_VECTOR_RUNTIME_FAILURES: Readonly<
  Record<string, 409 | 422>
> = {
  VECTOR_CONFLICT_VERSION_MISMATCH: 409,
  VECTOR_OWNER_CHANGED: 409,
  VECTOR_SAVE_CONFLICT_CREATED: 409,
  VECTOR_SAVE_CONFLICT_OPEN: 409,
  VECTOR_SAVE_SESSION_STALE: 409,
  VECTOR_SAVE_MIGRATION_FAILED: 422,
  VECTOR_SAVE_MIGRATION_PERSISTENCE_UNAVAILABLE: 422,
  VECTOR_SAVE_MIGRATOR_MISSING: 422,
  VECTOR_SAVE_SCHEMA_NEWER: 422,
};

export function classifyVectorRuntimeFailure(error: unknown): {
  code: string;
  status: 409 | 422 | 500;
  expected: boolean;
} {
  const message = error instanceof Error ? error.message : "";
  const status = EXPECTED_VECTOR_RUNTIME_FAILURES[message];
  if (status) return { code: message, status, expected: true };
  return { code: "VECTOR_RUNTIME_FAILED", status: 500, expected: false };
}

const VECTOR_EVENT_TYPES = new Set([
  "achievement.unlocked",
  "challenge.complete",
  "checkpoint",
  "collision",
  "level.complete",
  "level.start",
  "run.complete",
  "run.end",
  "run.start",
  "runtime.ready",
  "score.updated",
]);
const VECTOR_EVENT_METADATA_KEYS = new Set([
  "achievementId",
  "challenge",
  "completed",
  "difficulty",
  "durationMs",
  "level",
  "mode",
  "outcome",
  "perfect",
  "round",
  "score",
  "seedId",
  "streak",
]);
const VECTOR_EVENT_METADATA_STRING_VALUES: Readonly<
  Record<string, ReadonlySet<string>>
> = {
  challenge: new Set(["async", "daily", "none"]),
  difficulty: new Set(["easy", "normal", "hard", "expert"]),
  mode: new Set(["campaign", "challenge", "daily", "explore", "free", "solo"]),
  outcome: new Set(["aborted", "collision", "complete", "failure", "miss", "success"]),
};
const VECTOR_EVENT_MAX_METADATA_ENTRIES = 32;

/**
 * Treat game modules as an untrusted telemetry boundary. Only a small,
 * content-free event envelope may leave the runtime host.
 */
export function sanitizeVectorRuntimeEvent(
  event: VectorRuntimeEvent,
): VectorRuntimeEvent | null {
  if (
    !event
    || typeof event.type !== "string"
    || !VECTOR_EVENT_TYPES.has(event.type)
    || typeof event.occurredAt !== "string"
    || event.occurredAt.length > 40
  ) {
    return null;
  }
  const occurredAt = new Date(event.occurredAt);
  if (
    !Number.isFinite(occurredAt.getTime())
    || occurredAt.toISOString() !== event.occurredAt
  ) {
    return null;
  }
  if (event.metadata === undefined) {
    return { type: event.type, occurredAt: event.occurredAt };
  }
  if (
    event.metadata === null
    || Array.isArray(event.metadata)
    || typeof event.metadata !== "object"
  ) {
    return null;
  }
  const entries = Object.entries(event.metadata);
  if (entries.length > VECTOR_EVENT_MAX_METADATA_ENTRIES) return null;
  const metadata: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of entries) {
    if (!VECTOR_EVENT_METADATA_KEYS.has(key)) return null;
    if (typeof value === "string") {
      const allowedValues = VECTOR_EVENT_METADATA_STRING_VALUES[key];
      if (!allowedValues?.has(value)) return null;
      metadata[key] = value;
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value) || Math.abs(value) > 1_000_000_000_000) {
        return null;
      }
      metadata[key] = value;
      continue;
    }
    if (typeof value === "boolean" || value === null) {
      metadata[key] = value;
      continue;
    }
    return null;
  }
  return { type: event.type, occurredAt: event.occurredAt, metadata };
}

export type FixedStepTick = {
  steps: number;
  stepMs: number;
  elapsedMs: number;
  droppedMs: number;
  alpha: number;
};

export type FixedStepClock = {
  tick: (nowMs: number) => FixedStepTick;
  reset: (nowMs?: number) => void;
};

export function createFixedStepClock({
  targetFrameRate = 60,
  maxFrameDeltaMs = 250,
  maxStepsPerTick = 8,
}: {
  targetFrameRate?: 30 | 60;
  maxFrameDeltaMs?: number;
  maxStepsPerTick?: number;
} = {}): FixedStepClock {
  if (targetFrameRate <= 0 || maxFrameDeltaMs <= 0 || maxStepsPerTick < 1) {
    throw new Error("Invalid fixed-step clock configuration.");
  }

  const stepMs = 1000 / targetFrameRate;
  let previousMs: number | null = null;
  let accumulatorMs = 0;

  return {
    tick(nowMs) {
      if (!Number.isFinite(nowMs)) throw new Error("Fixed-step clock requires a finite timestamp.");
      if (previousMs === null) {
        previousMs = nowMs;
        return { steps: 0, stepMs, elapsedMs: 0, droppedMs: 0, alpha: 0 };
      }

      const elapsedMs = Math.min(Math.max(0, nowMs - previousMs), maxFrameDeltaMs);
      previousMs = nowMs;
      accumulatorMs += elapsedMs;

      const availableSteps = Math.floor(accumulatorMs / stepMs);
      const steps = Math.min(availableSteps, maxStepsPerTick);
      const droppedSteps = Math.max(0, availableSteps - steps);
      const droppedMs = droppedSteps * stepMs;
      accumulatorMs -= availableSteps * stepMs;

      return {
        steps,
        stepMs,
        elapsedMs,
        droppedMs,
        alpha: Math.min(1, Math.max(0, accumulatorMs / stepMs)),
      };
    },
    reset(nowMs) {
      previousMs = nowMs ?? null;
      accumulatorMs = 0;
    },
  };
}

export function createVectorRuntimeScheduler({
  targetFrameRate,
  requestFrame = (callback) => window.requestAnimationFrame(callback),
  cancelFrame = (handle) => window.cancelAnimationFrame(handle),
  onError,
}: {
  targetFrameRate: 30 | 60;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
  onError?: (error: unknown) => void;
}): VectorRuntimeScheduler {
  const clock = createFixedStepClock({ targetFrameRate });
  const listeners = new Set<(frame: VectorRuntimeFrame) => void>();
  let running = false;
  let disposed = false;
  let frameHandle: number | null = null;

  const schedule = () => {
    if (!running || disposed || frameHandle !== null) return;
    frameHandle = requestFrame(tick);
  };
  const tick: FrameRequestCallback = (nowMs) => {
    frameHandle = null;
    if (!running || disposed) return;
    const frame = { nowMs, ...clock.tick(nowMs) };
    try {
      for (const listener of listeners) listener(frame);
    } catch (error) {
      running = false;
      clock.reset();
      onError?.(error);
      return;
    }
    schedule();
  };

  return {
    subscribe(listener) {
      if (disposed) throw new Error("VECTOR_SCHEDULER_DISPOSED");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start() {
      if (disposed || running) return;
      running = true;
      clock.reset();
      schedule();
    },
    stop() {
      if (!running && frameHandle === null) return;
      running = false;
      if (frameHandle !== null) {
        cancelFrame(frameHandle);
        frameHandle = null;
      }
      clock.reset();
    },
    dispose() {
      if (disposed) return;
      running = false;
      disposed = true;
      if (frameHandle !== null) cancelFrame(frameHandle);
      frameHandle = null;
      clock.reset();
      listeners.clear();
    },
    isRunning() {
      return running && !disposed;
    },
  };
}

export type VectorRuntimeOperation =
  | "initialize"
  | "start"
  | "pause"
  | "suspend"
  | "resume"
  | "checkpoint"
  | "restart"
  | "settings"
  | "context-loss"
  | "context-restore"
  | "dispose";

export class VectorRuntimeStateError extends Error {
  readonly code = "VECTOR_RUNTIME_INVALID_STATE";

  constructor(
    readonly operation: VectorRuntimeOperation,
    readonly state: VectorRuntimeState,
  ) {
    super(`Cannot ${operation} VECTOR runtime while state is ${state}.`);
    this.name = "VectorRuntimeStateError";
  }
}

export type VectorRuntimeControllerOptions = {
  onSave?: (save: VectorSerializedSave, reason: VectorSaveReason) => void | Promise<void>;
  onStateChange?: (state: VectorRuntimeState) => void;
  onError?: (error: unknown, operation: VectorRuntimeOperation) => void;
};

export class VectorRuntimeController {
  private state: VectorRuntimeState = "idle";
  private operationQueue: Promise<void> = Promise.resolve();
  private disposing = false;
  private disposePromise: Promise<void> | null = null;

  constructor(
    private readonly instance: VectorGameInstance,
    private readonly options: VectorRuntimeControllerOptions = {},
  ) {}

  getState() {
    return this.state;
  }

  private setState(state: VectorRuntimeState) {
    if (this.disposing && state !== "disposed") return;
    if (this.state === state) return;
    this.state = state;
    this.options.onStateChange?.(state);
  }

  private enqueue<T>(operation: VectorRuntimeOperation, work: () => Promise<T>): Promise<T> {
    const pending = this.operationQueue.then(async () => {
      if (this.disposing || this.state === "disposed") {
        throw new VectorRuntimeStateError(operation, "disposed");
      }
      try {
        return await work();
      } catch (error) {
        this.setState("error");
        this.options.onError?.(error, operation);
        throw error;
      }
    });
    this.operationQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private requireState(operation: VectorRuntimeOperation, allowed: readonly VectorRuntimeState[]) {
    if (!allowed.includes(this.state)) throw new VectorRuntimeStateError(operation, this.state);
  }

  private async serializeAndSave(reason: VectorSaveReason) {
    if (this.disposing) return null;
    const save = await this.instance.serialize();
    if (this.disposing) return null;
    await this.options.onSave?.(save, reason);
    if (this.disposing) return null;
    return save;
  }

  initialize(save: VectorSerializedSave | null = null) {
    return this.enqueue("initialize", async () => {
      this.requireState("initialize", ["idle"]);
      this.setState("initializing");
      await this.instance.initialize();
      if (this.disposing) return;
      await this.instance.hydrate(save);
      if (this.disposing) return;
      this.setState("ready");
    });
  }

  start() {
    return this.enqueue("start", async () => {
      if (this.state === "running") return;
      this.requireState("start", ["ready"]);
      await this.instance.start();
      if (this.disposing) return;
      this.setState("running");
    });
  }

  pause(reason: VectorPauseReason = "user") {
    return this.enqueue("pause", async () => {
      if (this.state === "paused" || this.state === "suspended") return;
      this.requireState("pause", ["running"]);
      await this.instance.pause(reason);
      if (this.disposing) return;
      await this.serializeAndSave(reason === "visibility" ? "visibility" : "pause");
      if (this.disposing) return;
      this.setState(reason === "visibility" ? "suspended" : "paused");
    });
  }

  suspend(saveReason: Extract<VectorSaveReason, "visibility" | "pagehide"> = "visibility") {
    return this.enqueue("suspend", async () => {
      if (this.state === "suspended" || this.state === "paused") return;
      this.requireState("suspend", ["running"]);
      await this.instance.pause("visibility");
      if (this.disposing) return;
      await this.serializeAndSave(saveReason);
      if (this.disposing) return;
      this.setState("suspended");
    });
  }

  resume() {
    return this.enqueue("resume", async () => {
      if (this.state === "running") return;
      this.requireState("resume", ["paused", "suspended"]);
      await this.instance.resume();
      if (this.disposing) return;
      this.setState("running");
    });
  }

  checkpoint(reason: VectorSaveReason = "checkpoint") {
    if (this.disposing || this.state === "disposed") return Promise.resolve(null);
    return this.enqueue("checkpoint", async () => {
      if (!isVectorRuntimeCheckpointable(this.state)) return null;
      return this.serializeAndSave(reason);
    });
  }

  restart() {
    return this.enqueue("restart", async () => {
      this.requireState("restart", ["ready", "running", "paused", "suspended"]);
      if (this.state === "running") await this.instance.pause("system");
      if (this.disposing) return;
      await this.instance.reset();
      if (this.disposing) return;
      await this.serializeAndSave("restart");
      if (this.disposing) return;
      await this.instance.start();
      if (this.disposing) return;
      this.setState("running");
    });
  }

  updateSettings(settings: VectorRuntimeSettings) {
    return this.enqueue("settings", async () => {
      this.requireState("settings", ["ready", "running", "paused", "suspended"]);
      await this.instance.updateSettings?.(settings);
    });
  }

  handleContextLoss() {
    return this.enqueue("context-loss", async () => {
      if (this.state === "disposed" || this.state === "error") return;
      this.requireState("context-loss", ["ready", "running", "paused", "suspended"]);
      if (this.state === "running") await this.instance.pause("system");
      if (this.disposing) return;
      await this.instance.handleContextLoss?.();
      if (this.disposing) return;
      this.setState("suspended");
    });
  }

  handleContextRestore() {
    return this.enqueue("context-restore", async () => {
      this.requireState("context-restore", ["suspended"]);
      await this.instance.handleContextRestore?.();
    });
  }

  dispose() {
    if (this.disposePromise) return this.disposePromise;
    this.disposing = true;
    // A game may still be inside initialize/hydrate/serialize. Mark the
    // controller disposed immediately so no new operations can enter, but do
    // not tear down engine resources until the in-flight queue settles.
    this.setState("disposed");
    this.disposePromise = this.operationQueue
      .catch(() => undefined)
      .then(() => this.instance.dispose())
      .catch((error) => {
        this.options.onError?.(error, "dispose");
        throw error;
      });
    return this.disposePromise;
  }
}

export async function teardownVectorRuntime(
  controller: VectorRuntimeController,
  {
    checkpoint = true,
    reason = "route-exit",
  }: {
    checkpoint?: boolean;
    reason?: VectorSaveReason;
  } = {},
) {
  try {
    if (checkpoint && isVectorRuntimeCheckpointable(controller.getState())) {
      await controller.checkpoint(reason);
    }
  } finally {
    await controller.dispose();
  }
}
