/**
 * Brickrise — the VECTOR platformer shell (Wave 15.8).
 *
 * This file is the ONLY part of Brickrise that touches Phaser or the DOM.
 * Everything that decides what is true — movement, collision, hazards,
 * checkpoints, elapsed time, the score transform — lives in the pure modules
 * beside it and is tested without a canvas. Phaser's job here is narrow and
 * deliberate: draw the state the simulation produced, and capture raw input.
 * It never simulates.
 *
 * Two consequences of that split are load-bearing and easy to undo by accident:
 *
 *  1. Arcade Physics is not enabled and must not be. `stepBody` owns motion; a
 *     second physics system running alongside it would silently become the real
 *     authority the first time someone adds a sprite with a body.
 *  2. Phaser's own game loop is stopped. The VECTOR runtime scheduler
 *     (createFixedStepClock) is the single clock, so the same inputs advance
 *     the same number of fixed steps on every machine. Letting Phaser's rAF
 *     drive simulation would reintroduce the wall-clock dependence the pure
 *     modules exist to prevent. Because the loop is stopped, teardown must call
 *     `runDestroy()` explicitly — see dispose().
 *
 * The engine import below is a PLAIN dynamic import with no `webpackChunkName`
 * magic comment, and must stay that way: next.config.ts names the Phaser vendor
 * chunk through a splitChunks cacheGroup, and a magic comment competing for the
 * same name silently defeats both (see engine-chunks.test.ts).
 *
 * Artwork is deliberately absent. The registry keeps Brickrise `planned` until
 * the design layer delivers sprites and lighting; what draws below is neutral
 * placeholder geometry, and the palette is the seam where that work lands.
 */

import type {
  VectorGameCreateContext,
  VectorGameInstance,
  VectorGameModule,
  VectorRuntimeSettings,
  VectorSerializedSave,
} from "@/lib/vector/types";
import { INITIAL_BODY_STATE } from "@/lib/vector/games/brickrise/physics";
import {
  type BrickriseLevel,
  checkpointTriggerBox,
  generateBrickriseLevel,
} from "@/lib/vector/games/brickrise/level";
import {
  BRICKRISE_SAVE_SCHEMA_VERSION,
  type BrickriseRunState,
  fromPersistedScore,
  fromSaveData,
  initialRunState,
  toPersistedScore,
  toSaveData,
} from "@/lib/vector/games/brickrise/progress";
import { keyboardActionFor } from "@/lib/vector/games/brickrise/inputState";
import {
  type BrickriseSimulation,
  applyBrickriseInput,
  createBrickriseSimulation,
  stepBrickriseSimulation,
} from "@/lib/vector/games/brickrise/simulation";

const ROOT_CLASS = "vector-brickrise";

/** The camera's window onto the tower. Matches the manifest's landscape intent. */
const VIEWPORT = Object.freeze({ WIDTH: 960, HEIGHT: 540 });

/**
 * Placeholder geometry colours. Not a design decision and not a token set —
 * Brickrise stays `planned` in the registry precisely because this is where
 * real artwork has not landed yet.
 */
const PLACEHOLDER = Object.freeze({
  BACKGROUND: 0x0f1014,
  PLATFORM: 0x3b3b46,
  HAZARD: 0x8c3f3f,
  CHECKPOINT_PENDING: 0x455066,
  CHECKPOINT_BANKED: 0x4b7d5d,
  BODY: 0xcccdd8,
});

/** How quickly the camera closes on the body when motion is not reduced. */
const CAMERA_LERP = 0.12;

const SCORE_MODE = "climb";

const SCENE_KEY = "brickrise";

function formatDuration(totalMs: number): string {
  const totalSeconds = Math.max(0, Math.round(totalMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function newSeed(): string {
  return globalThis.crypto?.randomUUID?.() ?? `brickrise-${Date.now()}`;
}

export function createBrickriseGame(context: VectorGameCreateContext): VectorGameInstance {
  const doc = context.mount.ownerDocument ?? document;

  const root = doc.createElement("div");
  root.className = ROOT_CLASS;
  root.setAttribute("data-testid", "brickrise-root");
  // The play surface is decorative: every piece of state it shows is mirrored
  // as DOM text below, which is what the manifest's accessibility claim rests
  // on. Focus stays on the host's mount.
  root.tabIndex = -1;

  const live = doc.createElement("div");
  live.className = `${ROOT_CLASS}__live`;
  live.setAttribute("role", "status");
  live.setAttribute("aria-live", "polite");
  root.appendChild(live);

  const surface = doc.createElement("div");
  surface.className = `${ROOT_CLASS}__surface`;
  surface.setAttribute("aria-hidden", "true");
  root.appendChild(surface);

  const hud = doc.createElement("div");
  hud.className = `${ROOT_CLASS}__hud`;
  root.appendChild(hud);

  function hudField(testId: string, label: string): HTMLElement {
    const wrapper = doc.createElement("p");
    wrapper.className = `${ROOT_CLASS}__hud-field`;
    const name = doc.createElement("span");
    name.className = `${ROOT_CLASS}__hud-label`;
    name.textContent = label;
    const value = doc.createElement("span");
    value.className = `${ROOT_CLASS}__hud-value`;
    value.setAttribute("data-testid", testId);
    wrapper.append(name, value);
    hud.appendChild(wrapper);
    return value;
  }

  const checkpointField = hudField("brickrise-checkpoint", "Checkpoint");
  const deathsField = hudField("brickrise-deaths", "Falls");
  const elapsedField = hudField("brickrise-elapsed", "Elapsed");
  const bestField = hudField("brickrise-best", "Best summit");
  const statusField = hudField("brickrise-status", "Status");

  // The only way back to a fresh climb after the summit. The host toolbar has
  // nothing to pause once a run is complete, so this stays entirely in-band
  // rather than routing a finished run through the host's pause/restart flow
  // (which shows "Pause" over a game that has nothing left to pause). Hidden
  // until a run completes; renderHud() toggles it.
  const climbAgainButton = doc.createElement("button");
  climbAgainButton.type = "button";
  climbAgainButton.className = `${ROOT_CLASS}__climb-again`;
  climbAgainButton.setAttribute("data-testid", "brickrise-climb-again");
  climbAgainButton.textContent = "Climb again";
  climbAgainButton.hidden = true;
  hud.appendChild(climbAgainButton);

  const touch = doc.createElement("div");
  touch.className = `${ROOT_CLASS}__touch`;
  root.appendChild(touch);

  // Real buttons, not canvas hit zones: this is what makes the manifest's
  // `input.touch` claim honest, and it gives the same controls to a keyboard
  // and to assistive technology for free.
  function touchButton(testId: string, label: string): HTMLButtonElement {
    const button = doc.createElement("button");
    button.type = "button";
    button.className = `${ROOT_CLASS}__touch-button`;
    button.setAttribute("data-testid", testId);
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-pressed", "false");
    button.textContent = label;
    touch.appendChild(button);
    return button;
  }

  const leftButton = touchButton("brickrise-touch-left", "Move left");
  const rightButton = touchButton("brickrise-touch-right", "Move right");
  const jumpButton = touchButton("brickrise-touch-jump", "Jump");

  let disposed = false;
  let settings: VectorRuntimeSettings = context.settings;
  let unsubscribeScheduler: (() => void) | null = null;
  const listeners = new AbortController();

  let run: BrickriseRunState = initialRunState(newSeed());
  let level: BrickriseLevel = generateBrickriseLevel(run.seed);
  let simulation: BrickriseSimulation = createBrickriseSimulation(run, level, INITIAL_BODY_STATE);
  let previousBox = simulation.body.box;
  let running = false;
  let startEmitted = false;
  /** Forces one more draw while the run is not advancing (pause, resume, reset, restore). */
  let needsRedraw = true;
  /** Removers for the listeners Phaser installs but never takes back. */
  const phaserVisibilityCleanup: (() => void)[] = [];
  let restoreWindowHandlers: (() => void) | null = null;

  // Phaser handles, all null until initialize() resolves.
  type PhaserNamespace = typeof import("phaser");
  type PhaserGame = InstanceType<PhaserNamespace["Game"]>;
  type PhaserScene = InstanceType<PhaserNamespace["Scene"]>;
  type PhaserGraphics = ReturnType<PhaserScene["add"]["graphics"]>;

  let phaser: PhaserNamespace | null = null;
  let game: PhaserGame | null = null;
  let scene: PhaserScene | null = null;
  let graphics: PhaserGraphics | null = null;
  let cameraY = 0;

  function announce(message: string): void {
    live.textContent = message;
  }

  function renderHud(): void {
    const total = level.checkpoints.length;
    checkpointField.textContent =
      run.checkpointIndex === null ? `None of ${total}` : `${run.checkpointIndex + 1} of ${total}`;
    deathsField.textContent = String(run.deaths);
    elapsedField.textContent = formatDuration(run.elapsedMs);
    statusField.textContent = run.completed
      ? "Summit reached"
      : running
        ? "Climbing"
        : "Ready";
    climbAgainButton.hidden = !run.completed;
  }

  function refreshBestScore(): void {
    const read = context.getBestScore;
    if (!read) {
      // Absent, not a no-op — the host has nothing to wire it to, and saying so
      // is more honest than showing a blank that looks like "no score yet".
      bestField.textContent = "Not available here";
      return;
    }
    bestField.textContent = "Loading…";
    void read({ mode: SCORE_MODE, challengeId: null })
      .then((best) => {
        if (disposed) return;
        bestField.textContent = best === null ? "None yet" : formatDuration(fromPersistedScore(best));
      })
      .catch(() => {
        if (disposed) return;
        bestField.textContent = "Unavailable";
      });
  }

  function setPressed(button: HTMLButtonElement, pressed: boolean): void {
    button.setAttribute("aria-pressed", pressed ? "true" : "false");
  }

  function syncPressedState(): void {
    setPressed(leftButton, simulation.input.left);
    setPressed(rightButton, simulation.input.right);
    setPressed(jumpButton, simulation.input.jumpHeld);
  }

  function dispatch(action: Parameters<typeof applyBrickriseInput>[1]): void {
    simulation = applyBrickriseInput(simulation, action);
    syncPressedState();
  }

  function releaseAll(): void {
    dispatch({ type: "releaseAll" });
  }

  function finishRun(elapsedMs: number, deaths: number): void {
    const value = toPersistedScore(elapsedMs);
    context.emit({
      type: "run.complete",
      occurredAt: new Date().toISOString(),
      metadata: { mode: "solo", outcome: "complete", score: value, durationMs: elapsedMs },
    });
    void context.recordScore?.({ mode: SCORE_MODE, challengeId: null, value });
    announce(
      `Summit reached in ${formatDuration(elapsedMs)} with ${deaths} ${deaths === 1 ? "fall" : "falls"}.`,
    );
    // A completed run is not necessarily a new best — the persisted score
    // merge is Math.max over an inverted duration, so a slower climb never
    // touches the stored best. Re-read the authoritative value (as Second
    // Sense's finishRun does) instead of assuming this run's own time is now
    // on top.
    const read = context.getBestScore;
    if (!read) {
      // Absent, not a no-op — same reasoning as refreshBestScore above.
      bestField.textContent = "Not available here";
      return;
    }
    void read({ mode: SCORE_MODE, challengeId: null })
      .then((best) => {
        if (disposed) return;
        // recordScore is asynchronous and goes through the sync outbox, so a
        // read this fast can race ahead of the write and still report null
        // even on a genuine first climb. Falling back to this run's own time
        // is honest either way: it is the best known result until the outbox
        // says otherwise.
        bestField.textContent =
          best === null ? formatDuration(elapsedMs) : formatDuration(fromPersistedScore(best));
      })
      .catch(() => {
        if (disposed) return;
        bestField.textContent = "Unavailable";
      });
  }

  function handleFrame(frame: { steps: number; nowMs: number; elapsedMs: number; alpha: number }): void {
    if (disposed) return;

    if (running) {
      for (let step = 0; step < frame.steps; step += 1) {
        previousBox = simulation.body.box;
        const result = stepBrickriseSimulation(simulation);
        simulation = result.simulation;
        run = simulation.run;

        for (const event of result.events) {
          if (event.type === "death") {
            context.emit({
              type: "collision",
              occurredAt: new Date().toISOString(),
              metadata: { outcome: "collision" },
            });
            announce(
              event.respawnCheckpointIndex === null
                ? `Fell. Restarting from the base. ${event.deaths} ${event.deaths === 1 ? "fall" : "falls"}.`
                : `Fell. Returning to checkpoint ${event.respawnCheckpointIndex + 1}. ${event.deaths} ${event.deaths === 1 ? "fall" : "falls"}.`,
            );
            // The body teleports; interpolating from where it died would drag a
            // visible streak across the tower.
            previousBox = simulation.body.box;
          } else if (event.type === "checkpoint") {
            context.emit({
              type: "checkpoint",
              occurredAt: new Date().toISOString(),
              metadata: { round: event.index + 1 },
            });
            announce(`Checkpoint ${event.index + 1} of ${event.total} reached.`);
          } else {
            running = false;
            needsRedraw = true;
            finishRun(event.elapsedMs, event.deaths);
          }
        }
      }
      renderHud();
      // A death clears held input inside the simulation, so the buttons would
      // otherwise keep claiming aria-pressed="true" over a body that is no
      // longer moving.
      syncPressedState();
    }

    // When the run is paused or finished nothing moves, so redrawing and
    // stepping a full Phaser scene at 60 Hz would burn a core to present an
    // identical frame. One draw settles the surface; after that the loop idles
    // until something actually changes.
    if (!running && !needsRedraw) return;
    needsRedraw = false;

    drawWorld(frame.alpha);
    game?.step(frame.nowMs, frame.elapsedMs);
  }

  function drawWorld(alpha: number): void {
    if (!graphics || !scene) return;

    const body = simulation.body.box;
    // Interpolate between the last two fixed steps so the body reads smoothly
    // on displays faster than the 60 Hz simulation rate.
    const drawX = previousBox.x + (body.x - previousBox.x) * alpha;
    const drawY = previousBox.y + (body.y - previousBox.y) * alpha;

    const targetY = Math.max(
      0,
      Math.min(level.height - VIEWPORT.HEIGHT, drawY + body.height / 2 - VIEWPORT.HEIGHT / 2),
    );
    // Reduced motion snaps the camera rather than easing it: sustained
    // translation is the part of a climbing camera that provokes nausea.
    cameraY = settings.resolvedMotion === "reduced"
      ? targetY
      : cameraY + (targetY - cameraY) * CAMERA_LERP;
    scene.cameras.main.setScroll(0, cameraY);

    graphics.clear();

    for (const platform of level.platforms) {
      graphics.fillStyle(PLACEHOLDER.PLATFORM, 1);
      graphics.fillRect(platform.x, platform.y, platform.width, platform.height);
    }

    for (const hazard of level.hazards) {
      graphics.fillStyle(PLACEHOLDER.HAZARD, 1);
      graphics.fillRect(hazard.x, hazard.y, hazard.width, hazard.height);
    }

    for (const checkpoint of level.checkpoints) {
      const banked = run.checkpointIndex !== null && checkpoint.index <= run.checkpointIndex;
      const box = checkpointTriggerBox(checkpoint);
      graphics.fillStyle(banked ? PLACEHOLDER.CHECKPOINT_BANKED : PLACEHOLDER.CHECKPOINT_PENDING, 1);
      graphics.fillRect(box.x, box.y, box.width, box.height);
    }

    graphics.fillStyle(PLACEHOLDER.BODY, 1);
    graphics.fillRect(drawX, drawY, body.width, body.height);
  }

  function attachInput(): void {
    const { signal } = listeners;

    // Bind to the HOST'S MOUNT, not to `root`.
    //
    // The mount is the element GameRuntimeHost makes focusable (tabIndex={0})
    // and explicitly focuses on resume and restart. `root` is its child with
    // tabIndex=-1, so a keydown dispatched at the focused mount never
    // propagates down into it — binding there made the game completely
    // unplayable by keyboard while every unit test passed, because the tests
    // dispatched directly on `root`, a target that never occurs in production.
    const keyTarget = context.mount;

    keyTarget.addEventListener(
      "keydown",
      (event) => {
        const action = keyboardActionFor(event.code, "down");
        // Only claim keys the game actually uses. Escape in particular must
        // reach the host, which binds it to pause.
        if (!action) return;
        event.preventDefault();
        dispatch(action);
      },
      { signal },
    );

    keyTarget.addEventListener(
      "keyup",
      (event) => {
        const action = keyboardActionFor(event.code, "up");
        if (!action) return;
        event.preventDefault();
        dispatch(action);
      },
      { signal },
    );

    const bindHold = (
      button: HTMLButtonElement,
      down: Parameters<typeof applyBrickriseInput>[1],
      up: Parameters<typeof applyBrickriseInput>[1],
    ) => {
      // Track which pointer owns this hold. Without it, a second finger
      // touching and lifting on the same button releases the first finger's
      // hold — and because the input reducer ignores the action's `source`, a
      // stray touch release also cancels a direction held on the keyboard.
      let activePointerId: number | null = null;

      button.addEventListener(
        "pointerdown",
        (event) => {
          event.preventDefault();
          if (activePointerId !== null) return;
          activePointerId = event.pointerId;
          // Capture so a thumb sliding off the button still delivers its
          // release here, rather than leaving the input latched on.
          button.setPointerCapture?.(event.pointerId);
          dispatch(down);
        },
        { signal },
      );

      for (const type of ["pointerup", "pointercancel", "lostpointercapture"] as const) {
        button.addEventListener(
          type,
          (event) => {
            if (activePointerId !== event.pointerId) return;
            activePointerId = null;
            dispatch(up);
          },
          { signal },
        );
      }
    };

    bindHold(
      leftButton,
      { type: "moveStart", source: "touch", direction: -1 },
      { type: "moveEnd", source: "touch", direction: -1 },
    );
    bindHold(
      rightButton,
      { type: "moveStart", source: "touch", direction: 1 },
      { type: "moveEnd", source: "touch", direction: 1 },
    );
    bindHold(jumpButton, { type: "jumpDown", source: "touch" }, { type: "jumpUp", source: "touch" });

    // Losing focus or visibility with a key held would otherwise run the body
    // off a ledge while the player is not looking at it.
    //
    // `focusout`, not `blur`: blur does not bubble, so a listener on the mount
    // would never fire for focus leaving a descendant — and a listener on the
    // never-focused `root` would never fire at all.
    keyTarget.addEventListener("focusout", () => releaseAll(), { signal });
    doc.addEventListener(
      "visibilitychange",
      () => {
        if (doc.visibilityState === "hidden") releaseAll();
      },
      { signal },
    );

    // "Climb again" is Brickrise's own affordance, not the host's restart
    // flow: nothing here is being abandoned, so it skips straight to a fresh
    // climb rather than opening the host's "are you sure" restart modal.
    climbAgainButton.addEventListener(
      "click",
      () => {
        performReset();
        performStart();
      },
      { signal },
    );
  }

  function performStart(): void {
    if (run.completed) return;
    running = true;
    releaseAll();
    if (!startEmitted) {
      startEmitted = true;
      context.emit({
        type: "run.start",
        occurredAt: new Date().toISOString(),
        metadata: { mode: "solo" },
      });
    }
    announce(
      run.checkpointIndex === null
        ? "Climb started at the base of the tower."
        : `Climb resumed from checkpoint ${run.checkpointIndex + 1}.`,
    );
    renderHud();
  }

  function performReset(): void {
    running = false;
    startEmitted = false;
    // A restart re-rolls the tower. The seed is not player-visible and the
    // manifest does not promise a stable layout, so a fresh climb is a fresh
    // climb.
    run = initialRunState(newSeed());
    level = generateBrickriseLevel(run.seed);
    simulation = createBrickriseSimulation(run, level, INITIAL_BODY_STATE);
    previousBox = simulation.body.box;
    cameraY = 0;
    scene?.cameras.main.setBounds(0, 0, level.width, level.height);
    syncPressedState();
    needsRedraw = true;
    renderHud();
    announce("Climb reset.");
    // finishRun may have left bestField showing this session's own run time
    // (see the comment there); a restart must not carry that value forward
    // into a run that has not finished yet.
    refreshBestScore();
  }

  const instance: VectorGameInstance = {
    async initialize() {
      context.mount.replaceChildren(root);

      // Plain import, no magic comment — see the file header.
      const loaded = await import("phaser");
      if (disposed) return;
      phaser = (loaded as unknown as { default?: PhaserNamespace }).default ?? (loaded as PhaserNamespace);

      // Phaser 3.90's VisibilityHandler (core/VisibilityHandler.js) attaches a
      // document-level visibilitychange listener and overwrites
      // window.onblur/onfocus, and NOTHING in destroy()/runDestroy() undoes
      // either. The listener closes over the Game's event emitter, so without
      // this every runtime retry would strand a dead listener holding a
      // destroyed Game — and would silently clobber any host handler.
      //
      // Phaser exposes no hook for it, so the handler is captured by shimming
      // addEventListener for the duration of construction only, matched
      // narrowly to the visibility events VisibilityHandler registers.
      const priorOnBlur = window.onblur;
      const priorOnFocus = window.onfocus;
      const nativeAdd = doc.addEventListener.bind(doc);
      const VISIBILITY_EVENTS = new Set([
        "visibilitychange",
        "webkitvisibilitychange",
        "mozvisibilitychange",
        "msvisibilitychange",
      ]);
      doc.addEventListener = ((
        type: string,
        handler: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
      ) => {
        if (VISIBILITY_EVENTS.has(type)) {
          phaserVisibilityCleanup.push(() => doc.removeEventListener(type, handler, options));
        }
        return nativeAdd(type, handler, options);
      }) as Document["addEventListener"];
      restoreWindowHandlers = () => {
        window.onblur = priorOnBlur;
        window.onfocus = priorOnFocus;
      };

      await new Promise<void>((resolve) => {
        const created = new phaser!.Game({
          type: phaser!.AUTO,
          parent: surface,
          width: VIEWPORT.WIDTH,
          height: VIEWPORT.HEIGHT,
          backgroundColor: PLACEHOLDER.BACKGROUND,
          banner: false,
          autoFocus: false,
          // Silence is a manifest claim (`audio.available: false`), not an
          // oversight — no audio asset exists yet.
          audio: { noAudio: true },
          // Phaser must not install window-level input listeners: focus,
          // Escape, and pointer capture all belong to the host.
          input: { keyboard: false, mouse: false, touch: false, gamepad: false },
          // No `physics` key. stepBody is the only physics in this game.
          scale: {
            mode: phaser!.Scale.FIT,
            autoCenter: phaser!.Scale.CENTER_BOTH,
            width: VIEWPORT.WIDTH,
            height: VIEWPORT.HEIGHT,
          },
          render: { powerPreference: settings.lowPower ? "low-power" : "high-performance" },
          // create() only signals readiness; the scene is fetched from the
          // manager below rather than captured off `this`, which keeps the
          // handle typed and avoids aliasing a callback receiver.
          scene: { key: SCENE_KEY, create: () => resolve() },
        });
        game = created;
      });

      // Narrow the shim's blast radius: restore the real addEventListener the
      // moment the engine has booted, whether or not we go on to dispose.
      doc.addEventListener = nativeAdd;

      if (disposed) return;

      scene = game?.scene.getScene(SCENE_KEY) ?? null;
      if (scene) {
        graphics = scene.add.graphics();
        scene.cameras.main.setBounds(0, 0, level.width, level.height);
      }
      // Hand the clock to the VECTOR scheduler. From here Phaser only draws
      // when we step it.
      game?.loop.stop();

      attachInput();
      unsubscribeScheduler = context.scheduler.subscribe(handleFrame);

      renderHud();
      refreshBestScore();
      context.emit({ type: "runtime.ready", occurredAt: new Date().toISOString() });
    },

    hydrate(save: VectorSerializedSave | null) {
      const restored = save ? fromSaveData(save.data) : null;
      // fromSaveData already rejects corrupt or future-versioned saves, so a
      // null here means "start fresh", never "half-restore".
      run = restored ?? initialRunState(newSeed());
      level = generateBrickriseLevel(run.seed);
      simulation = createBrickriseSimulation(run, level, INITIAL_BODY_STATE);
      previousBox = simulation.body.box;
      cameraY = Math.max(
        0,
        Math.min(level.height - VIEWPORT.HEIGHT, simulation.body.box.y - VIEWPORT.HEIGHT / 2),
      );
      scene?.cameras.main.setBounds(0, 0, level.width, level.height);
      needsRedraw = true;
      renderHud();
    },

    start() {
      performStart();
    },

    pause() {
      running = false;
      // Drop held inputs rather than the position: nothing about the run is
      // lost, but the body cannot drift while the game is not being watched.
      releaseAll();
      needsRedraw = true;
      renderHud();
    },

    resume() {
      if (run.completed) return;
      running = true;
      needsRedraw = true;
      renderHud();
    },

    serialize(): VectorSerializedSave {
      return {
        schemaVersion: BRICKRISE_SAVE_SCHEMA_VERSION,
        data: toSaveData(run),
        seed: run.seed,
      };
    },

    reset() {
      performReset();
    },

    updateSettings(next: VectorRuntimeSettings) {
      settings = next;
      // Motion preference changes how the camera tracks, so the current frame
      // is now stale even though nothing in the run moved.
      needsRedraw = true;
    },

    handleContextLoss() {
      // Stop stepping immediately. Drawing into a lost context is what turns a
      // recoverable blip into a stream of console errors.
      running = false;
      releaseAll();
      statusField.textContent = "Display context lost";
    },

    handleContextRestore() {
      renderHud();
      // Draw AND present: drawWorld only mutates the graphics object, so
      // without a step the restored canvas would stay blank until the run
      // resumes.
      needsRedraw = true;
      drawWorld(0);
      game?.step(0, 0);
    },

    dispose() {
      if (disposed) return;
      disposed = true;

      unsubscribeScheduler?.();
      unsubscribeScheduler = null;
      listeners.abort();

      // Phaser's own listeners, which its teardown leaves behind.
      for (const remove of phaserVisibilityCleanup.splice(0)) remove();
      restoreWindowHandlers?.();
      restoreWindowHandlers = null;

      if (game) {
        const canvas = game.canvas;
        // destroy() only flags pendingDestroy and defers the real teardown to
        // the next step — which will never come, because the loop is stopped.
        // runDestroy() is what actually releases the renderer.
        //
        // It is public at runtime (Phaser 3.90 Game.js) but absent from the
        // published type definitions, hence the narrow cast rather than a
        // blanket `any` on the game handle.
        game.destroy(true, false);
        (game as PhaserGame & { runDestroy?: () => void }).runDestroy?.();
        game = null;
        // Belt and braces: browsers cap live WebGL contexts, and this component
        // remounts on every runtime retry. A context that outlives its canvas
        // exhausts that budget a few retries later, far from the cause.
        if (canvas) {
          const gl =
            (canvas.getContext("webgl2") as WebGLRenderingContext | null)
            ?? (canvas.getContext("webgl") as WebGLRenderingContext | null);
          gl?.getExtension("WEBGL_lose_context")?.loseContext();
        }
      }
      scene = null;
      graphics = null;
      phaser = null;

      context.mount.replaceChildren();
    },
  };

  return instance;
}

export const brickriseGameModule: VectorGameModule = {
  createGame: createBrickriseGame,
};

export default brickriseGameModule;
