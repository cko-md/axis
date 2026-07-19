"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { StatusCallout } from "@/components/ui/StatusCallout";
import { captureRouteError } from "@/lib/observability/captureRouteError";
import { loadVectorGame } from "@/lib/vector/loaders";
import {
  prepareVectorRuntimeSave,
  type VectorSaveMigrationResult,
} from "@/lib/vector/merge";
import {
  bindVectorPointerCapture,
  classifyVectorRuntimeFailure,
  clampVectorAutosaveInterval,
  createVectorRuntimeScheduler,
  createVectorRuntimeFinalizationBarrier,
  DEFAULT_VECTOR_AUTOSAVE_INTERVAL_MS,
  isVectorRuntimeCheckpointable,
  sanitizeVectorRuntimeEvent,
  teardownVectorRuntime,
  VectorRuntimeController,
  type VectorRuntimeOperation,
} from "@/lib/vector/runtime";
import type {
  VectorGameManifest,
  VectorGameScoreInput,
  VectorRuntimeEvent,
  VectorRuntimeSettings,
  VectorRuntimeState,
  VectorSaveReason,
  VectorSerializedSave,
} from "@/lib/vector/types";
import styles from "./Vector.module.css";

type Props = {
  manifest: VectorGameManifest;
  settings: VectorRuntimeSettings;
  initialSave?: VectorSerializedSave | null;
  autosaveIntervalMs?: number;
  onSave?: (save: VectorSerializedSave, reason: VectorSaveReason) => void | Promise<void>;
  onSaveMigrationFailure?: (
    code: Extract<VectorSaveMigrationResult, { ok: false }>["code"],
  ) => void | Promise<void>;
  registerOwnerTransitionBarrier?: (
    barrier: () => void | Promise<void>,
  ) => () => void;
  onEvent?: (event: VectorRuntimeEvent) => void;
  onStateChange?: (state: VectorRuntimeState) => void;
  onRuntimeError?: (operation: VectorRuntimeOperation) => void;
  onRecordScore?: (input: VectorGameScoreInput) => void | Promise<void>;
  onGetBestScore?: (input: { mode: string; challengeId: string | null }) => Promise<number | null>;
};

const UPDATEABLE_STATES: readonly VectorRuntimeState[] = [
  "ready",
  "running",
  "paused",
  "suspended",
];

function runtimeMessage(state: VectorRuntimeState) {
  if (state === "initializing") return "Preparing runtime";
  if (state === "ready") return "Ready";
  if (state === "running") return "Running";
  if (state === "paused") return "Paused";
  if (state === "suspended") return "Suspended";
  if (state === "error") return "Runtime error";
  if (state === "disposed") return "Closed";
  return "Idle";
}

export function GameRuntimeHost({
  manifest,
  settings,
  initialSave = null,
  autosaveIntervalMs = DEFAULT_VECTOR_AUTOSAVE_INTERVAL_MS,
  onSave,
  onSaveMigrationFailure,
  registerOwnerTransitionBarrier,
  onEvent,
  onStateChange,
  onRuntimeError,
  onRecordScore,
  onGetBestScore,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const mountRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<VectorRuntimeController | null>(null);
  const teardownRef = useRef<Promise<void>>(Promise.resolve());
  const callbacksRef = useRef({
    onSave,
    onSaveMigrationFailure,
    onEvent,
    onStateChange,
    onRuntimeError,
    onRecordScore,
    onGetBestScore,
  });
  const initialSaveRef = useRef(initialSave);
  const settingsRef = useRef(settings);
  const [runtimeState, setRuntimeState] = useState<VectorRuntimeState>("idle");
  const [retryNonce, setRetryNonce] = useState(0);
  const [errorOperation, setErrorOperation] = useState<VectorRuntimeOperation | null>(null);
  const [restartOpen, setRestartOpen] = useState(false);

  callbacksRef.current = {
    onSave,
    onSaveMigrationFailure,
    onEvent,
    onStateChange,
    onRuntimeError,
    onRecordScore,
    onGetBestScore,
  };
  initialSaveRef.current = initialSave;
  settingsRef.current = settings;

  useEffect(() => {
    let cancelled = false;
    let controller: VectorRuntimeController | null = null;
    let scheduler: ReturnType<typeof createVectorRuntimeScheduler> | null = null;
    let controllerReported = false;
    let runtimeFinalizer: ReturnType<
      typeof createVectorRuntimeFinalizationBarrier
    > | null = null;
    let unregisterOwnerTransitionBarrier: (() => void) | undefined;
    // A runtime must never switch to a newly rendered owner's save callback
    // while an old controller is still serializing during teardown.
    const runtimeOnSave = callbacksRef.current.onSave;
    const runtimeOnSaveMigrationFailure =
      callbacksRef.current.onSaveMigrationFailure;

    const trackTeardown = (teardown: Promise<void>) => {
      teardownRef.current = Promise.all([
        teardownRef.current,
        teardown.catch(() => undefined),
      ]).then(() => undefined);
      return teardownRef.current;
    };

    const reportFailure = (error: unknown, operation: VectorRuntimeOperation) => {
      scheduler?.stop();
      const failedController = controller;
      if (failedController && failedController.getState() !== "disposed") {
        void trackTeardown(failedController.dispose());
      }
      if (!cancelled) {
        setErrorOperation(operation);
        setRuntimeState("error");
        callbacksRef.current.onRuntimeError?.(operation);
      }
      // Engine errors can contain private save state. Only exact platform
      // codes cross this boundary; every other failure uses a fixed envelope.
      const failure = classifyVectorRuntimeFailure(error);
      captureRouteError(new Error(failure.code), {
        route: `vector.game.${manifest.id}`,
        operation,
        area: "vector",
        status: failure.status,
        code: failure.code,
        tags: {
          engine: manifest.engine,
          game_version: manifest.version,
          save_schema_version: manifest.saveSchemaVersion,
          expected: failure.expected,
        },
      });
    };

    const boot = async () => {
      await teardownRef.current;
      if (cancelled) return;
      const mount = mountRef.current;
      if (!mount) {
        reportFailure(new Error("VECTOR_RUNTIME_MOUNT_MISSING"), "initialize");
        return;
      }

      setErrorOperation(null);
      setRuntimeState("initializing");
      mount.replaceChildren();

      try {
        const gameModule = await loadVectorGame(manifest.loaderKey);
        if (cancelled) return;

        const preparedSave = prepareVectorRuntimeSave(
          initialSaveRef.current,
          manifest.saveSchemaVersion,
          gameModule.saveMigrators ?? [],
        );
        if (!preparedSave.ok) {
          await runtimeOnSaveMigrationFailure?.(preparedSave.code);
          throw new Error(`VECTOR_${preparedSave.code}`);
        }
        const hydrationSave = preparedSave.save;
        if (preparedSave.migrated && hydrationSave) {
          if (!runtimeOnSave) {
            await runtimeOnSaveMigrationFailure?.("SAVE_MIGRATION_FAILED");
            throw new Error("VECTOR_SAVE_MIGRATION_PERSISTENCE_UNAVAILABLE");
          }
          await runtimeOnSave(hydrationSave, "migration");
        }
        scheduler = createVectorRuntimeScheduler({
          targetFrameRate: manifest.targetFrameRate,
          onError: (error) => reportFailure(error, "start"),
        });
        const instance = await gameModule.createGame({
          mount,
          manifest,
          settings: settingsRef.current,
          scheduler,
          emit: (event) => {
            const sanitized = sanitizeVectorRuntimeEvent(event);
            if (sanitized) {
              callbacksRef.current.onEvent?.(sanitized);
              return;
            }
            captureRouteError(new Error("VECTOR_RUNTIME_EVENT_INVALID"), {
              route: `vector.game.${manifest.id}`,
              operation: "runtime_event",
              area: "vector",
              status: 500,
              code: "VECTOR_RUNTIME_EVENT_INVALID",
              tags: {
                engine: manifest.engine,
                game_version: manifest.version,
              },
            });
          },
          recordScore: callbacksRef.current.onRecordScore
            ? (input) => callbacksRef.current.onRecordScore?.(input)
            : undefined,
          getBestScore: callbacksRef.current.onGetBestScore
            ? (input) => callbacksRef.current.onGetBestScore!(input)
            : undefined,
        });
        if (cancelled) {
          scheduler.dispose();
          await trackTeardown(
            Promise.resolve(instance.dispose()).catch((error) => {
              reportFailure(error, "dispose");
            }),
          );
          return;
        }

        controller = new VectorRuntimeController(instance, {
          onSave: (save, reason) => {
            return runtimeOnSave?.(save, reason);
          },
          onStateChange: (state) => {
            if (state === "running") scheduler?.start();
            else scheduler?.stop();
            if (cancelled) return;
            setRuntimeState(state);
            callbacksRef.current.onStateChange?.(state);
          },
          onError: (_error, operation) => {
            controllerReported = true;
            reportFailure(_error, operation);
          },
        });
        controllerRef.current = controller;
        const activeController = controller;
        runtimeFinalizer = createVectorRuntimeFinalizationBarrier({
          async checkpoint() {
            if (!isVectorRuntimeCheckpointable(activeController.getState())) {
              return false;
            }
            await activeController.checkpoint("route-exit");
            return true;
          },
          finalize(needsCheckpoint) {
            return teardownVectorRuntime(activeController, {
              checkpoint: needsCheckpoint,
            });
          },
          release() {
            scheduler?.dispose();
            unregisterOwnerTransitionBarrier?.();
          },
        });
        unregisterOwnerTransitionBarrier = registerOwnerTransitionBarrier?.(
          runtimeFinalizer.checkpointForOwnerTransition,
        );
        await controller.initialize(hydrationSave);
        if (cancelled) return;
        await controller.updateSettings(settingsRef.current);
        if (cancelled) return;
        await controller.start();
      } catch (error) {
        scheduler?.dispose();
        if (!controllerReported) reportFailure(error, "initialize");
      }
    };

    void boot();

    return () => {
      cancelled = true;
      if (controllerRef.current === controller) controllerRef.current = null;
      scheduler?.stop();
      if (runtimeFinalizer) {
        void trackTeardown(runtimeFinalizer.finalize());
      } else {
        scheduler?.dispose();
        unregisterOwnerTransitionBarrier?.();
      }
    };
  }, [manifest, registerOwnerTransitionBarrier, retryNonce]);

  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller || !UPDATEABLE_STATES.includes(controller.getState())) return;
    void controller.updateSettings(settings).catch(() => undefined);
  }, [settings]);

  useEffect(() => {
    const intervalMs = clampVectorAutosaveInterval(autosaveIntervalMs);
    const timer = window.setInterval(() => {
      const controller = controllerRef.current;
      if (controller?.getState() === "running") {
        void controller.checkpoint("autosave").catch(() => undefined);
      }
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [autosaveIntervalMs]);

  useEffect(() => {
    const suspend = () => {
      const controller = controllerRef.current;
      if (controller?.getState() === "running") {
        void controller.suspend().catch(() => undefined);
      }
    };
    const pauseForBlur = () => {
      const controller = controllerRef.current;
      if (controller?.getState() === "running") {
        void controller.pause("blur").catch(() => undefined);
      }
    };
    const suspendForPageHide = () => {
      const controller = controllerRef.current;
      if (controller?.getState() === "running") {
        void controller.suspend("pagehide").catch(() => undefined);
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") suspend();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !rootRef.current?.contains(document.activeElement)) return;
      const controller = controllerRef.current;
      if (controller?.getState() === "running") {
        event.preventDefault();
        void controller.pause("user").catch(() => undefined);
      }
    };
    const onContextLost = (event: Event) => {
      event.preventDefault();
      const controller = controllerRef.current;
      if (controller) void controller.handleContextLoss().catch(() => undefined);
    };
    const onContextRestored = () => {
      const controller = controllerRef.current;
      if (controller?.getState() === "suspended") {
        void controller.handleContextRestore().catch(() => undefined);
      }
    };
    const mount = mountRef.current;

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", suspendForPageHide);
    window.addEventListener("blur", pauseForBlur);
    document.addEventListener("keydown", onKeyDown);
    mount?.addEventListener("webglcontextlost", onContextLost, true);
    mount?.addEventListener("webglcontextrestored", onContextRestored, true);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", suspendForPageHide);
      window.removeEventListener("blur", pauseForBlur);
      document.removeEventListener("keydown", onKeyDown);
      mount?.removeEventListener("webglcontextlost", onContextLost, true);
      mount?.removeEventListener("webglcontextrestored", onContextRestored, true);
    };
  }, []);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    return bindVectorPointerCapture(mount);
  }, []);

  const pause = () => {
    void controllerRef.current?.pause("user").catch(() => undefined);
  };
  const resume = () => {
    void controllerRef.current?.resume().then(() => {
      mountRef.current?.focus({ preventScroll: true });
    }).catch(() => undefined);
  };
  const restart = () => {
    setRestartOpen(false);
    void controllerRef.current?.restart().then(() => {
      mountRef.current?.focus({ preventScroll: true });
    }).catch(() => undefined);
  };

  return (
    <div ref={rootRef} className={styles.runtimeHost} data-runtime-state={runtimeState}>
      <div className={styles.runtimeStatus} role="status" aria-live="polite">
        <span aria-hidden="true" />
        {runtimeMessage(runtimeState)}
      </div>
      <div
        ref={mountRef}
        className={styles.gameMount}
        role="region"
        aria-label={`${manifest.title} play surface`}
        tabIndex={0}
      />

      {runtimeState === "initializing" || runtimeState === "idle" ? (
        <div className={styles.runtimeOverlay}>
          <strong>Preparing {manifest.title}</strong>
          <span>The engine chunk and local save are loading.</span>
        </div>
      ) : null}

      {runtimeState === "paused" || runtimeState === "suspended" ? (
        <div className={styles.runtimeOverlay}>
          <strong>{runtimeState === "suspended" ? "Game suspended" : "Game paused"}</strong>
          <span>
            {runtimeState === "suspended"
              ? "The page lost visibility or the graphics context changed."
              : "A local checkpoint was requested before the runtime paused."}
          </span>
          <div className={styles.runtimeActions}>
            <Button variant="primary" onClick={resume}>Resume</Button>
            <Button variant="danger" onClick={() => setRestartOpen(true)}>Restart</Button>
          </div>
        </div>
      ) : null}

      {runtimeState === "error" ? (
        <div className={styles.runtimeOverlay}>
          <StatusCallout kind="error" title="The VECTOR runtime could not continue.">
            The failure is visible and recorded with safe game metadata. No save is being claimed.
          </StatusCallout>
          <div className={styles.runtimeActions}>
            <Button
              variant="primary"
              onClick={() => {
                setErrorOperation(null);
                setRetryNonce((value) => value + 1);
              }}
            >
              Retry runtime
            </Button>
            {errorOperation ? <code>{errorOperation}</code> : null}
          </div>
        </div>
      ) : null}

      {runtimeState === "running" ? (
        <div className={styles.runtimeToolbar}>
          <Button variant="ghost" onClick={pause}>Pause</Button>
          <span>Escape pauses · progress autosaves locally</span>
        </div>
      ) : null}

      <Modal
        open={restartOpen}
        onClose={() => setRestartOpen(false)}
        title={`Restart ${manifest.title}`}
        motion={settings.resolvedMotion}
        footer={(
          <>
            <Button onClick={() => setRestartOpen(false)}>Cancel</Button>
            <Button variant="danger" onClick={restart}>Restart game</Button>
          </>
        )}
      >
        <p>
          Reset the active run to its initial state? The runtime will serialize the
          reset state through the configured persistence callback.
        </p>
      </Modal>
    </div>
  );
}
