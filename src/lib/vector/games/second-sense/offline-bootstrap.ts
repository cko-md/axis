/**
 * Standalone offline bootstrap for Second Sense.
 *
 * This is the code that runs when a player opens `/vector/second-sense` with
 * no network connection: the service worker (public/sw.js) substitutes this
 * bundle's HTML shell (public/vector-assets/offline/second-sense.html) for
 * the real Next.js route, because that route cannot be server-rendered
 * offline. It is built by scripts/build-vector-offline-bootstrap.mjs into
 * public/vector-assets/offline/second-sense.js — a stable, non-webpack-hashed
 * path — and referenced directly from the static HTML shell.
 *
 * It has no React/Next dependency and shares its actual game engine
 * (game.ts), persistence (persistence.ts), and runtime host (runtime.ts) with
 * the online path: one engine, two hosts. It reuses the SAME "axis-vector"
 * IndexedDB database and the SAME owner key already established while
 * online, so a save made here is picked up by the normal reconnect
 * push/pull/merge flow the next time the app runs online — there is no
 * separate offline data silo.
 *
 * Deliberately simpler than GameRuntimeHost.tsx: there is no owner-transition
 * barrier (no sign-in is possible offline) and no save-migration retry UI (a
 * conflict discovered offline is left for the online app, which has the full
 * conflict-resolution surface).
 */
import { getVectorGame } from "@/lib/vector/registry";
import { createSecondSenseGame } from "@/lib/vector/games/second-sense/game";
import { vectorJsonSchema } from "@/lib/vector/contracts";
import {
  openVectorRepository,
  VectorPersistenceError,
  vectorScoreKey,
  type VectorPersistence,
} from "@/lib/vector/persistence";
import type { VectorOwnerKey } from "@/lib/vector/persistence-types";
import {
  createVectorRuntimeScheduler,
  isVectorRuntimeCheckpointable,
  teardownVectorRuntime,
  VectorRuntimeController,
} from "@/lib/vector/runtime";
import {
  DEFAULT_VECTOR_RUNTIME_SETTINGS,
  type VectorSerializedSave,
} from "@/lib/vector/types";

const GAME_ID = "second-sense";
const SLOT_ID = "main";
const AUTOSAVE_INTERVAL_MS = 30_000;

type BootStatus =
  | "loading"
  | "unavailable"
  | "quota"
  | "conflict"
  | "error"
  | "ready";

function setStatus(root: HTMLElement, status: BootStatus, message: string): void {
  root.setAttribute("data-offline-status", status);
  const statusEl = root.querySelector<HTMLElement>("[data-offline-status-text]");
  if (statusEl) statusEl.textContent = message;
}

function errorCode(error: unknown): string {
  if (error instanceof VectorPersistenceError) return error.code;
  if (error instanceof Error) return error.message;
  return "VECTOR_OFFLINE_UNKNOWN_ERROR";
}

async function boot(): Promise<void> {
  const root = document.getElementById("second-sense-offline-root");
  const mount = document.getElementById("second-sense-offline-mount");
  if (!root || !mount) return;

  if (typeof indexedDB === "undefined") {
    setStatus(root, "unavailable", "This browser does not expose IndexedDB, so no offline save can load.");
    return;
  }

  const manifest = getVectorGame(GAME_ID);
  if (!manifest) {
    setStatus(root, "error", "VECTOR_OFFLINE_MANIFEST_MISSING");
    return;
  }

  let repository: VectorPersistence;
  let ownerKey: VectorOwnerKey;
  let deviceId: string;
  try {
    const opened = await openVectorRepository();
    repository = opened.repository;
    ownerKey = opened.ownerKey;
    deviceId = opened.deviceId;
  } catch (error) {
    if (errorCode(error) === "VECTOR_LOCAL_QUOTA_EXCEEDED") {
      setStatus(root, "quota", "Local storage is full, so no offline save can be read or written.");
    } else {
      setStatus(root, "error", "The owner-scoped VECTOR database could not open on this device.");
    }
    return;
  }

  let initialSave: VectorSerializedSave | null = null;
  let ancestor: { localRevision: number; checksum: string } | null = null;
  try {
    const row = await repository.loadSave(ownerKey, GAME_ID, SLOT_ID);
    if (row) {
      initialSave = {
        schemaVersion: row.saveSchemaVersion,
        data: row.state,
        checksum: row.checksum,
        ...(row.seed !== null ? { seed: row.seed } : {}),
      };
      ancestor = { localRevision: row.localRevision, checksum: row.checksum };
    }
  } catch (error) {
    if (errorCode(error) === "VECTOR_SAVE_CORRUPT") {
      setStatus(
        root,
        "conflict",
        "A preserved save branch needs your explicit choice. Reconnect and open Second Sense online to resolve it before playing offline.",
      );
      return;
    }
    setStatus(root, "error", "The local save record could not be read.");
    return;
  }

  setStatus(root, "ready", "Playing offline. Progress saves to this device and syncs once you reconnect.");
  mount.replaceChildren();

  const scheduler = createVectorRuntimeScheduler({
    targetFrameRate: manifest.targetFrameRate,
    onError: () => {
      setStatus(root, "error", "The offline runtime stopped after an internal error.");
    },
  });

  const instance = createSecondSenseGame({
    mount,
    manifest,
    settings: DEFAULT_VECTOR_RUNTIME_SETTINGS,
    scheduler,
    emit: () => {
      // Offline telemetry has nowhere safe to go (no network, no Sentry
      // transport); this bundle intentionally drops runtime events rather
      // than queue or fabricate a delivery.
    },
    recordScore: async (input) => {
      try {
        await repository.enqueueEvent(ownerKey, GAME_ID, {
          kind: "score",
          idempotencyKey: crypto.randomUUID(),
          localRevision: Date.now(),
          occurredAt: new Date().toISOString(),
          payload: input,
        });
      } catch {
        // A locally-unrecorded score does not block play; the run's result
        // stays visible on screen even if this particular write failed.
      }
    },
    getBestScore: async (input) => {
      try {
        const profile = await repository.loadProfile(ownerKey);
        if (!profile) return null;
        return profile.scores[vectorScoreKey({ gameId: GAME_ID, ...input })] ?? null;
      } catch {
        return null;
      }
    },
  });

  const controller = new VectorRuntimeController(instance, {
    async onSave(save) {
      const parsedState = vectorJsonSchema.safeParse(save.data);
      if (!parsedState.success) return;
      try {
        const result = await repository.saveLocalWithAncestor({
          ownerKey,
          gameId: GAME_ID,
          slotId: SLOT_ID,
          gameVersion: manifest.version,
          saveSchemaVersion: manifest.saveSchemaVersion,
          deviceId,
          seed: save.seed ?? null,
          state: parsedState.data,
        }, ancestor);
        if (result.status === "saved") {
          ancestor = { localRevision: result.save.localRevision, checksum: result.save.checksum };
        }
      } catch {
        // A failed offline checkpoint is not fatal to the current session;
        // the in-memory run continues and the next autosave retries.
      }
    },
    onStateChange(state) {
      if (state === "running") scheduler.start();
      else scheduler.stop();
    },
    onError() {
      setStatus(root, "error", "The offline runtime could not continue. Reload to try again.");
    },
  });

  await controller.initialize(initialSave);
  await controller.start();

  const autosave = window.setInterval(() => {
    if (isVectorRuntimeCheckpointable(controller.getState())) {
      void controller.checkpoint("autosave");
    }
  }, AUTOSAVE_INTERVAL_MS);

  const onVisibilityChange = () => {
    if (document.visibilityState === "hidden" && controller.getState() === "running") {
      void controller.suspend("visibility");
    }
  };
  const onPageHide = () => {
    void teardownVectorRuntime(controller, { reason: "pagehide" });
  };
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("beforeunload", () => {
    window.clearInterval(autosave);
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void boot());
} else {
  void boot();
}
