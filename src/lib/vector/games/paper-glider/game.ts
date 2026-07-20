/**
 * Paper Glider — the VECTOR continuous-flight shell (Wave 15.10).
 *
 * This file is the ONLY part of Paper Glider that touches Three.js or the DOM.
 * Everything that decides what is true — flight motion, room generation,
 * doorway/furniture/bounds collision, ring capture, distance, the score
 * transform — lives in the pure modules beside it (physics/level/progress/
 * simulation) and is tested without a WebGL context. Three's job here is
 * narrow and deliberate: draw the state the simulation produced, and carry the
 * canvas raw input arrives through. It never simulates.
 *
 * Two consequences of that split are load-bearing and easy to undo by accident:
 *
 *  1. The VECTOR runtime scheduler is the single clock. Each scheduler frame
 *     advances `stepPaperGliderSimulation` exactly `frame.steps` fixed steps —
 *     the same per-step entry point the completability sweep flies — and Three
 *     renders the result. There is no renderer-owned animation loop, no rAF
 *     callback, and no analytic fast-forward anywhere in this file (a source
 *     scan in game.test.ts holds this); adding one would reintroduce the
 *     wall-clock dependence the pure modules exist to prevent.
 *  2. The engine import below is a PLAIN dynamic import with no
 *     `webpackChunkName` magic comment, and must stay that way: next.config.ts
 *     names the Three vendor chunk through a splitChunks cacheGroup, and a
 *     magic comment competing for the same name silently defeats both (see
 *     engine-chunks.test.ts).
 *
 * Teardown is deterministic because the host remounts this component on every
 * runtime retry: dispose() releases the scheduler subscription, every DOM
 * listener (one AbortController), every geometry and material this file
 * created, the renderer, and then forces WEBGL_lose_context on the canvas —
 * browsers cap live WebGL contexts, and a context that outlives its canvas
 * exhausts that budget a few retries later, far from the cause. Three's own
 * event listeners live on the canvas itself (context-loss events), not on
 * document or window, so releasing the canvas releases them too.
 *
 * Artwork is deliberately absent. The registry keeps Paper Glider `planned`
 * until the design layer delivers real art; what draws below is neutral
 * placeholder geometry, and the palette is the seam where that work lands.
 */

import type {
  VectorGameCreateContext,
  VectorGameInstance,
  VectorGameModule,
  VectorRuntimeFrame,
  VectorRuntimeSettings,
  VectorSerializedSave,
} from "@/lib/vector/types";
import { PAPER_GLIDER_PHYSICS, speedAtDistance } from "@/lib/vector/games/paper-glider/physics";
import {
  PAPER_GLIDER_LEVEL_CONFIG,
  type PaperGliderRoom,
  roomAtDistance,
} from "@/lib/vector/games/paper-glider/level";
import {
  currentScore,
  fromSaveData,
  initialSaveData,
  mergeBest,
  PAPER_GLIDER_SAVE_SCHEMA_VERSION,
  type PaperGliderCollisionReason,
  type PaperGliderSaveData,
  ringCollectionKey,
} from "@/lib/vector/games/paper-glider/progress";
import {
  createPaperGliderSimulation,
  type PaperGliderSimulation,
  type PaperGliderStepEvent,
  stepPaperGliderSimulation,
} from "@/lib/vector/games/paper-glider/simulation";
import {
  INITIAL_PAPER_GLIDER_INPUT,
  keyboardSteerKeyFor,
  type PaperGliderInputAction,
  reducePaperGliderInput,
  steerTargetFrom,
} from "@/lib/vector/games/paper-glider/inputState";

type ThreeNamespace = typeof import("three");
type ThreeRenderer = import("three").WebGLRenderer;
type ThreeScene = import("three").Scene;
type ThreeCamera = import("three").PerspectiveCamera;
type ThreeMesh = import("three").Mesh;
type ThreeGroup = import("three").Group;
type ThreeBufferGeometry = import("three").BufferGeometry;
type ThreeMaterial = import("three").Material;

const ROOT_CLASS = "vector-paper-glider";

const SCORE_MODE = "flight";

/**
 * Placeholder geometry colours. Not a design decision and not a token set —
 * Paper Glider stays `planned` in the registry precisely because this is where
 * real artwork has not landed yet.
 */
const PLACEHOLDER = Object.freeze({
  BACKGROUND: 0x1a1712,
  WALL: 0x4f4638,
  FURNITURE: 0x6b5a45,
  RING: 0xd8b45a,
  RING_COLLECTED: 0x55503f,
  GLIDER: 0xe8e2d4,
  ROOM_EDGE: 0x3a3428,
});

/** Chase-camera framing: behind the glider, slightly above, looking down +z. */
const CAMERA = Object.freeze({
  BACK: 6,
  HEIGHT: 1.6,
  LOOK_AHEAD: 8,
  /** How quickly the camera closes laterally on the glider when motion is not reduced. */
  LERP: 0.18,
});

/**
 * Cosmetic glider attitude, linear in the simulated velocity. Render-only
 * feedback — it never writes back into the simulation — and it is suppressed
 * entirely under reduced motion (the manifest's reducedMotionBehavior claim).
 */
const ATTITUDE = Object.freeze({ ROLL_PER_VX: -1.1, PITCH_PER_VY: 0.55 });

/** Rooms kept built around the glider. Ahead stays comfortably inside the far plane; behind is pruned so an endless flight cannot accrete geometry. */
const ROOM_WINDOW = Object.freeze({ BEHIND: 1, AHEAD: 3 });

/** Visual thickness of a doorway wall. The collision model is the plane at exit.z (see simulation.ts); this only makes that plane readable. */
const WALL_VISUAL_DEPTH = 0.8;

function newSeed(): string {
  return globalThis.crypto?.randomUUID?.() ?? `paper-glider-${Date.now()}`;
}

function collisionLabel(reason: PaperGliderCollisionReason): string {
  switch (reason) {
    case "wall":
      return "Hit the wall beside a doorway";
    case "furniture":
      return "Hit furniture";
    case "bounds":
      return "Hit the room edge";
  }
}

export function createPaperGliderGame(context: VectorGameCreateContext): VectorGameInstance {
  const doc = context.mount.ownerDocument ?? document;

  const root = doc.createElement("div");
  root.className = ROOT_CLASS;
  root.setAttribute("data-testid", "paper-glider-root");
  // The play surface is decorative: every piece of state it shows is mirrored
  // as DOM text below, which is what the manifest's accessibility claim rests
  // on. Focus stays on the host's mount.
  root.tabIndex = -1;
  root.style.width = "100%";
  root.style.height = "100%";
  root.style.position = "relative";
  // Steering is a continuous drag; without this a touch steer scrolls the page.
  root.style.touchAction = "none";

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

  const scoreField = hudField("paper-glider-score", "Score");
  const distanceField = hudField("paper-glider-distance", "Distance");
  const ringsField = hudField("paper-glider-rings", "Rings");
  const speedField = hudField("paper-glider-speed", "Speed");
  const statusField = hudField("paper-glider-status", "Status");
  const resultField = hudField("paper-glider-result", "Result");
  const bestField = hudField("paper-glider-best", "Best flight");

  // The only way back to a fresh flight after a crash. The host toolbar has
  // nothing to pause once a run is over, so this stays entirely in-band —
  // the same reasoning as Brickrise's "Climb again". Hidden until a run ends.
  const flyAgainButton = doc.createElement("button");
  flyAgainButton.type = "button";
  flyAgainButton.className = `${ROOT_CLASS}__fly-again`;
  flyAgainButton.setAttribute("data-testid", "paper-glider-fly-again");
  flyAgainButton.textContent = "Fly again";
  flyAgainButton.hidden = true;
  hud.appendChild(flyAgainButton);

  let disposed = false;
  let contextLost = false;
  let running = false;
  let startEmitted = false;
  /** Forces one more draw while the run is not advancing (pause, resume, reset, restore, resize). */
  let needsRedraw = true;
  let settings: VectorRuntimeSettings = context.settings;
  let unsubscribeScheduler: (() => void) | null = null;
  let resizeObserver: ResizeObserver | null = null;
  const listeners = new AbortController();

  let input = INITIAL_PAPER_GLIDER_INPUT;
  /** The touch/pen pointer that owns steering; a second finger must not steal or release it. Mouse hover steers without ownership. */
  let activeTouchPointerId: number | null = null;

  let simulation: PaperGliderSimulation = createPaperGliderSimulation(newSeed());
  let previousBody = simulation.body;
  /** Cross-run bests — the whole of the persisted save (no mid-flight resume exists; see progress.ts). */
  let best: PaperGliderSaveData = initialSaveData();

  // Three handles, all null until initialize() resolves.
  let three: ThreeNamespace | null = null;
  let renderer: ThreeRenderer | null = null;
  let scene: ThreeScene | null = null;
  let camera: ThreeCamera | null = null;
  let gliderMesh: ThreeMesh | null = null;

  /**
   * Every geometry and material this shell creates, in one place, so dispose()
   * provably releases each of them. Room meshes reuse these shared resources
   * (a unit box scaled per mesh, one torus, shared materials), which is what
   * keeps an endlessly extending level from accreting undisposable GPU
   * resources: pruning a room group removes meshes but never orphans a
   * geometry only that room owned.
   */
  type SharedResources = Readonly<{
    unitBox: ThreeBufferGeometry;
    roomEdges: ThreeBufferGeometry;
    ringGeometry: ThreeBufferGeometry;
    gliderGeometry: ThreeBufferGeometry;
    wallMaterial: ThreeMaterial;
    furnitureMaterial: ThreeMaterial;
    ringMaterial: ThreeMaterial;
    ringCollectedMaterial: ThreeMaterial;
    gliderMaterial: ThreeMaterial;
    edgeMaterial: ThreeMaterial;
  }>;
  let resources: SharedResources | null = null;

  /** Built room groups by room index. */
  const roomGroups = new Map<number, ThreeGroup>();
  /** Ring meshes by collection key, for flipping to the collected material. */
  const ringMeshes = new Map<string, ThreeMesh>();
  /** Which ring keys each built room owns, so pruning a room prunes its ring handles. */
  const roomRingKeys = new Map<number, readonly string[]>();

  function announce(message: string): void {
    live.textContent = message;
  }

  function renderHud(): void {
    const run = simulation.run;
    scoreField.textContent = String(currentScore(run));
    distanceField.textContent = String(Math.round(run.distance));
    ringsField.textContent = String(run.ringsCollected);
    speedField.textContent = `${(speedAtDistance(simulation.body.z) / PAPER_GLIDER_PHYSICS.SPEED_BASE).toFixed(1)}×`;
    statusField.textContent = contextLost
      ? "Display context lost"
      : !run.alive
        ? "Flight over"
        : running
          ? "Flying"
          : "Ready";
    flyAgainButton.hidden = run.alive;
  }

  function refreshBestScore(): void {
    const read = context.getBestScore;
    if (!read) {
      // Absent, not a no-op — the host has nothing to wire it to, and saying
      // so is more honest than showing a blank that looks like "no score yet".
      bestField.textContent = "Not available here";
      return;
    }
    bestField.textContent = "Loading…";
    void read({ mode: SCORE_MODE, challengeId: null })
      .then((value) => {
        if (disposed) return;
        bestField.textContent = value === null ? "None yet" : String(value);
      })
      .catch(() => {
        if (disposed) return;
        bestField.textContent = "Unavailable";
      });
  }

  function dispatch(action: PaperGliderInputAction): void {
    input = reducePaperGliderInput(input, action);
  }

  function releaseAll(): void {
    activeTouchPointerId = null;
    dispatch({ type: "releaseAll" });
  }

  function finishRun(event: Extract<PaperGliderStepEvent, { type: "collision" }>): void {
    // The raw pure-core reason ("wall" | "furniture" | "bounds") is not in the
    // sanitizer's outcome allow-list; passing it verbatim would null the whole
    // event. The generic "collision" outcome is what the envelope carries; the
    // specific reason lives in the DOM result text and the live region.
    context.emit({
      type: "collision",
      occurredAt: new Date().toISOString(),
      metadata: { outcome: "collision" },
    });
    context.emit({
      type: "run.end",
      occurredAt: new Date().toISOString(),
      metadata: { mode: "solo", outcome: "collision", score: event.score },
    });

    // Bests record finished flights only — the run folds in here, at its end,
    // and mergeBest's per-field Math.max keeps the fold idempotent and
    // monotonic (the shared VECTOR merge rule).
    best = mergeBest(best, simulation.run);
    void context.recordScore?.({ mode: SCORE_MODE, challengeId: null, value: event.score });

    const label = collisionLabel(event.reason);
    resultField.textContent = `${label} at ${Math.round(event.distance)} — score ${event.score}`;
    announce(`${label}. Flight ended at ${Math.round(event.distance)} for a score of ${event.score}.`);

    // A finished run is not necessarily a new best — the persisted merge is
    // Math.max, so a shorter flight never touches the stored value. Re-read
    // the authoritative number rather than assuming this run is now on top.
    const read = context.getBestScore;
    if (!read) {
      bestField.textContent = "Not available here";
      return;
    }
    void read({ mode: SCORE_MODE, challengeId: null })
      .then((value) => {
        if (disposed) return;
        // recordScore goes through the async sync outbox, so a read this fast
        // can race ahead of the write and report null even on a genuine first
        // flight. This run's own score is the best known result until the
        // outbox says otherwise.
        bestField.textContent = value === null ? String(event.score) : String(value);
      })
      .catch(() => {
        if (disposed) return;
        bestField.textContent = "Unavailable";
      });
  }

  function handleStepEvents(events: readonly PaperGliderStepEvent[]): void {
    for (const event of events) {
      if (event.type === "ring") {
        context.emit({
          type: "score.updated",
          occurredAt: new Date().toISOString(),
          metadata: { score: currentScore(simulation.run) },
        });
        announce(`Ring collected — ${simulation.run.ringsCollected} banked.`);
      } else if (event.type === "roomCleared") {
        announce(`Room ${event.roomIndex} cleared.`);
      } else {
        running = false;
        needsRedraw = true;
        finishRun(event);
      }
    }
  }

  function handleFrame(frame: VectorRuntimeFrame): void {
    if (disposed) return;

    if (running) {
      for (let step = 0; step < frame.steps; step += 1) {
        previousBody = simulation.body;
        const result = stepPaperGliderSimulation(
          simulation,
          steerTargetFrom(input, simulation.body),
        );
        simulation = result.simulation;
        handleStepEvents(result.events);
        // A collision ends the run mid-batch; the remaining steps of this
        // frame have nothing to advance (the simulation is inert by contract).
        if (!running) break;
      }
      renderHud();
    }

    // When the run is paused or finished nothing moves, so re-rendering the
    // scene at 60 Hz would burn a core presenting an identical frame. One
    // draw settles the surface; after that the loop idles until something
    // actually changes.
    if (!running && !needsRedraw) return;
    needsRedraw = false;

    syncWorld();
    drawScene(frame.alpha);
  }

  function viewportSize(): { width: number; height: number } {
    const rect = context.mount.getBoundingClientRect();
    return {
      width: Math.max(1, Math.floor(rect.width)),
      height: Math.max(1, Math.floor(rect.height)),
    };
  }

  function applySize(): void {
    if (!renderer || !camera) return;
    const { width, height } = viewportSize();
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  }

  /** A wall segment as a scaled unit box — shared geometry, no per-room allocation. */
  function addWallSegment(
    group: ThreeGroup,
    centerX: number,
    centerY: number,
    width: number,
    height: number,
    z: number,
  ): void {
    if (!three || !resources || width <= 0.01 || height <= 0.01) return;
    const segment = new three.Mesh(resources.unitBox, resources.wallMaterial);
    segment.position.set(centerX, centerY, z);
    segment.scale.set(width, height, WALL_VISUAL_DEPTH);
    group.add(segment);
  }

  function buildRoomGroup(room: PaperGliderRoom): ThreeGroup | null {
    if (!three || !resources) return null;
    const C = PAPER_GLIDER_LEVEL_CONFIG;
    const group = new three.Group();

    // Room volume as wireframe edges — placeholder spatial reference.
    const edges = new three.LineSegments(resources.roomEdges, resources.edgeMaterial);
    edges.position.set(0, 0, (room.entry.z + room.exit.z) / 2);
    edges.scale.set(C.ROOM_HALF_WIDTH * 2, C.ROOM_HALF_HEIGHT * 2, room.exit.z - room.entry.z);
    group.add(edges);

    // The exit wall: four segments around the doorway. The collision model is
    // the plane at exit.z (see simulation.ts); these only make it visible.
    const opening = room.exit;
    const leftEdge = opening.x - opening.halfWidth;
    const rightEdge = opening.x + opening.halfWidth;
    const bottomEdge = opening.y - opening.halfHeight;
    const topEdge = opening.y + opening.halfHeight;
    addWallSegment(
      group,
      (-C.ROOM_HALF_WIDTH + leftEdge) / 2,
      0,
      leftEdge - -C.ROOM_HALF_WIDTH,
      C.ROOM_HALF_HEIGHT * 2,
      opening.z,
    );
    addWallSegment(
      group,
      (rightEdge + C.ROOM_HALF_WIDTH) / 2,
      0,
      C.ROOM_HALF_WIDTH - rightEdge,
      C.ROOM_HALF_HEIGHT * 2,
      opening.z,
    );
    addWallSegment(
      group,
      opening.x,
      (topEdge + C.ROOM_HALF_HEIGHT) / 2,
      opening.halfWidth * 2,
      C.ROOM_HALF_HEIGHT - topEdge,
      opening.z,
    );
    addWallSegment(
      group,
      opening.x,
      (-C.ROOM_HALF_HEIGHT + bottomEdge) / 2,
      opening.halfWidth * 2,
      bottomEdge - -C.ROOM_HALF_HEIGHT,
      opening.z,
    );

    for (const box of room.furniture) {
      const mesh = new three.Mesh(resources.unitBox, resources.furnitureMaterial);
      mesh.position.set(box.x, box.y, box.z);
      mesh.scale.set(box.halfX * 2, box.halfY * 2, box.halfZ * 2);
      group.add(mesh);
    }

    const keys: string[] = [];
    for (const ring of room.rings) {
      const key = ringCollectionKey(room.index, ring.index);
      const collected = simulation.run.collectedRingKeys.includes(key);
      const mesh = new three.Mesh(
        resources.ringGeometry,
        collected ? resources.ringCollectedMaterial : resources.ringMaterial,
      );
      mesh.position.set(ring.x, ring.y, ring.z);
      group.add(mesh);
      ringMeshes.set(key, mesh);
      keys.push(key);
    }
    roomRingKeys.set(room.index, keys);

    return group;
  }

  function pruneRoomGroup(index: number): void {
    const group = roomGroups.get(index);
    if (!group) return;
    scene?.remove(group);
    roomGroups.delete(index);
    for (const key of roomRingKeys.get(index) ?? []) ringMeshes.delete(key);
    roomRingKeys.delete(index);
    // Meshes reference only shared geometry/materials — nothing per-room to
    // dispose here; dispose() releases the shared set once, at the end.
  }

  /** Keep the built scene graph tracking the (auto-extending) level around the glider. */
  function syncWorld(): void {
    if (!three || !scene || !resources) return;
    const level = simulation.level;
    const currentIndex = roomAtDistance(level, simulation.body.z).index;
    const minIndex = Math.max(1, currentIndex - ROOM_WINDOW.BEHIND);
    const maxIndex = Math.min(level.rooms.length, currentIndex + ROOM_WINDOW.AHEAD);

    for (const index of [...roomGroups.keys()]) {
      if (index < minIndex || index > maxIndex) pruneRoomGroup(index);
    }
    for (let index = minIndex; index <= maxIndex; index += 1) {
      if (roomGroups.has(index)) continue;
      const group = buildRoomGroup(level.rooms[index - 1]);
      if (group) {
        roomGroups.set(index, group);
        scene.add(group);
      }
    }

    for (const key of simulation.run.collectedRingKeys) {
      const mesh = ringMeshes.get(key);
      if (mesh && mesh.material !== resources.ringCollectedMaterial) {
        mesh.material = resources.ringCollectedMaterial;
      }
    }
  }

  /**
   * Draw the current state. Positions are interpolated between the previous
   * and current fixed step by `alpha` so the flight reads smoothly on
   * displays faster than the simulation rate — interpolation is linear
   * arithmetic and strictly render-side; nothing here writes back into the
   * simulation. Camera orientation (lookAt) may use trig freely for the same
   * reason: it is downstream of the simulation, never an input to it.
   */
  function drawScene(alpha: number): void {
    if (disposed || contextLost || !renderer || !scene || !camera) return;

    const prev = previousBody;
    const body = simulation.body;
    const drawX = prev.x + (body.x - prev.x) * alpha;
    const drawY = prev.y + (body.y - prev.y) * alpha;
    const drawZ = prev.z + (body.z - prev.z) * alpha;

    if (gliderMesh) {
      gliderMesh.position.set(drawX, drawY, drawZ);
      // Cosmetic bank/pitch from simulated velocity — linear, render-only,
      // and entirely absent under reduced motion (never merely damped, so the
      // preference produces a stable horizon, not a subtler wobble).
      if (settings.resolvedMotion === "reduced") {
        gliderMesh.rotation.set(0, 0, 0);
      } else {
        gliderMesh.rotation.set(body.vy * ATTITUDE.PITCH_PER_VY, 0, body.vx * ATTITUDE.ROLL_PER_VX);
      }
    }

    // Chase camera: z tight-follows (forward motion is monotonic; lagging it
    // only widens the gap), x/y ease under standard motion and snap under
    // reduced motion — sustained lateral swing is the nauseating part of a
    // chase camera, so the reduced branch removes it outright.
    const targetX = drawX;
    const targetY = drawY + CAMERA.HEIGHT;
    if (settings.resolvedMotion === "reduced") {
      camera.position.set(targetX, targetY, drawZ - CAMERA.BACK);
    } else {
      camera.position.set(
        camera.position.x + (targetX - camera.position.x) * CAMERA.LERP,
        camera.position.y + (targetY - camera.position.y) * CAMERA.LERP,
        drawZ - CAMERA.BACK,
      );
    }
    camera.lookAt(drawX, drawY, drawZ + CAMERA.LOOK_AHEAD);

    renderer.render(scene, camera);
  }

  /** Map a client-space position to normalized [-1, 1] steer coordinates over the mount. */
  function normalizedSteer(event: { clientX: number; clientY: number }): { nx: number; ny: number } | null {
    const rect = context.mount.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const rawX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    const rawY = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
    return {
      nx: Math.max(-1, Math.min(1, rawX)),
      ny: Math.max(-1, Math.min(1, rawY)),
    };
  }

  function attachInput(): void {
    const { signal } = listeners;

    // Bind to the HOST'S MOUNT, not to `root`. The mount is the element
    // GameRuntimeHost makes focusable and explicitly focuses on resume and
    // restart; `root` is its child with tabIndex=-1, so a keydown dispatched
    // at the focused mount never propagates down into it. Binding there made
    // Brickrise completely unplayable by keyboard while every unit test
    // passed — the tests dispatched on a target production never uses.
    const target = context.mount;

    target.addEventListener(
      "keydown",
      (event) => {
        const key = keyboardSteerKeyFor(event.code);
        // Only claim keys the game actually uses. Tab must keep moving focus
        // and Escape must reach the host, which binds it to pause (WCAG 2.1.2).
        if (!key) return;
        event.preventDefault();
        dispatch({ type: "keyDown", key });
      },
      { signal },
    );

    target.addEventListener(
      "keyup",
      (event) => {
        const key = keyboardSteerKeyFor(event.code);
        if (!key) return;
        event.preventDefault();
        dispatch({ type: "keyUp", key });
      },
      { signal },
    );

    // Pointer steering. The manifest promises "Pointer movement" for mouse
    // (hover steers, no button required) and "Touch drag" for touch — both
    // arrive as pointer events and reduce into the same state machine. Touch
    // needs ownership (a second finger must not steal or release the steer);
    // mouse hover has no ownership to track.
    target.addEventListener(
      "pointerdown",
      (event) => {
        if (event.pointerType !== "mouse") {
          if (activeTouchPointerId !== null) return;
          activeTouchPointerId = event.pointerId;
          // Capture so a thumb sliding off the surface keeps steering and
          // still delivers its release here, rather than latching the steer.
          target.setPointerCapture?.(event.pointerId);
        }
        const steer = normalizedSteer(event);
        if (steer) dispatch({ type: "pointerSteer", nx: steer.nx, ny: steer.ny });
      },
      { signal },
    );

    target.addEventListener(
      "pointermove",
      (event) => {
        if (event.pointerType !== "mouse" && event.pointerId !== activeTouchPointerId) return;
        const steer = normalizedSteer(event);
        if (steer) dispatch({ type: "pointerSteer", nx: steer.nx, ny: steer.ny });
      },
      { signal },
    );

    for (const type of ["pointerup", "pointercancel", "lostpointercapture"] as const) {
      target.addEventListener(
        type,
        (event) => {
          // Mouse keeps steering by hover after release; touch releases its
          // steer (the glider then holds course — see steerTargetFrom).
          if (event.pointerType === "mouse") return;
          if (event.pointerId !== activeTouchPointerId) return;
          activeTouchPointerId = null;
          dispatch({ type: "pointerRelease" });
        },
        { signal },
      );
    }

    target.addEventListener(
      "pointerleave",
      (event) => {
        if (event.pointerType === "mouse") dispatch({ type: "pointerRelease" });
      },
      { signal },
    );

    // Losing focus or visibility with a steer held would otherwise fly the
    // glider into a wall while the player is not looking at it.
    //
    // `focusout`, not `blur`: blur does not bubble, so a listener on the mount
    // would never fire for focus leaving a descendant.
    target.addEventListener("focusout", () => releaseAll(), { signal });
    doc.addEventListener(
      "visibilitychange",
      () => {
        if (doc.visibilityState === "hidden") releaseAll();
      },
      { signal },
    );

    // "Fly again" is Paper Glider's own affordance, not the host's restart
    // flow: nothing is being abandoned after a crash, so it skips straight to
    // a fresh flight rather than opening the host's "are you sure" modal.
    flyAgainButton.addEventListener(
      "click",
      () => {
        performReset();
        performStart();
      },
      { signal },
    );
  }

  function performStart(): void {
    if (disposed || !simulation.run.alive) return;
    running = true;
    if (!startEmitted) {
      startEmitted = true;
      context.emit({
        type: "run.start",
        occurredAt: new Date().toISOString(),
        metadata: { mode: "solo" },
      });
    }
    announce("Flight started.");
    needsRedraw = true;
    renderHud();
  }

  function performReset(): void {
    running = false;
    startEmitted = false;
    releaseAll();
    // A restart re-rolls the flight. The seed is not player-visible and the
    // manifest's deterministicSeed is false: a fresh flight is a fresh seed,
    // never a re-roll of the last one (see createPaperGliderSimulation).
    simulation = createPaperGliderSimulation(newSeed());
    previousBody = simulation.body;
    // The old rooms belong to the old seed; drop them so the next draw
    // rebuilds from the new level rather than blending two flights.
    for (const index of [...roomGroups.keys()]) pruneRoomGroup(index);
    resultField.textContent = "—";
    needsRedraw = true;
    renderHud();
    announce("Flight reset.");
    // finishRun may have left bestField showing this session's own score (see
    // the comment there); a restart must not carry that forward into a run
    // that has not finished yet.
    refreshBestScore();
  }

  const instance: VectorGameInstance = {
    async initialize() {
      context.mount.replaceChildren(root);

      // Plain import, no magic comment — see the file header.
      const loaded = await import("three");
      // dispose() may have raced this import; creating a renderer now would
      // leak a WebGL context nothing will ever release.
      if (disposed) return;
      three = loaded;

      renderer = new three.WebGLRenderer({
        antialias: false,
        powerPreference: settings.lowPower ? "low-power" : "default",
      });
      renderer.setPixelRatio(settings.lowPower ? 1 : Math.min(window.devicePixelRatio || 1, 2));
      surface.replaceChildren(renderer.domElement);

      scene = new three.Scene();
      scene.background = new three.Color(PLACEHOLDER.BACKGROUND);
      camera = new three.PerspectiveCamera(60, 1, 0.1, 200);
      camera.position.set(0, CAMERA.HEIGHT, -CAMERA.BACK);

      // A single untextured paper fold: the smallest honest stand-in for the
      // glider until the design wave ships real art. Deliberately larger than
      // the collision hull (see PAPER_GLIDER_PHYSICS.HULL_RADIUS) so a near
      // miss reads as a near miss.
      const gliderGeometry = new three.BufferGeometry();
      gliderGeometry.setAttribute(
        "position",
        new three.Float32BufferAttribute(
          [0, 0, 1, -0.8, 0.1, -1, 0, 0.15, -0.6, 0, 0.15, -0.6, 0.8, 0.1, -1, 0, 0, 1],
          3,
        ),
      );
      gliderGeometry.computeVertexNormals();

      // The edges wireframe derives from the SAME unit box the wall/furniture
      // meshes scale — one shared source geometry, so dispose() releases
      // exactly what was created with no derived orphan.
      const unitBox = new three.BoxGeometry(1, 1, 1);
      resources = {
        unitBox,
        roomEdges: new three.EdgesGeometry(unitBox),
        ringGeometry: new three.TorusGeometry(PAPER_GLIDER_LEVEL_CONFIG.RING_TRIGGER_RADIUS, 0.07, 8, 24),
        gliderGeometry,
        wallMaterial: new three.MeshBasicMaterial({ color: PLACEHOLDER.WALL }),
        furnitureMaterial: new three.MeshBasicMaterial({ color: PLACEHOLDER.FURNITURE }),
        ringMaterial: new three.MeshBasicMaterial({ color: PLACEHOLDER.RING }),
        ringCollectedMaterial: new three.MeshBasicMaterial({ color: PLACEHOLDER.RING_COLLECTED }),
        gliderMaterial: new three.MeshBasicMaterial({ color: PLACEHOLDER.GLIDER, side: three.DoubleSide }),
        edgeMaterial: new three.LineBasicMaterial({ color: PLACEHOLDER.ROOM_EDGE }),
      };

      gliderMesh = new three.Mesh(resources.gliderGeometry, resources.gliderMaterial);
      gliderMesh.name = "paper-glider-body";
      scene.add(gliderMesh);

      applySize();
      resizeObserver = new ResizeObserver(() => {
        applySize();
        needsRedraw = true;
        drawScene(1);
      });
      resizeObserver.observe(context.mount);

      attachInput();
      unsubscribeScheduler = context.scheduler.subscribe(handleFrame);

      syncWorld();
      drawScene(1);
      renderHud();
      refreshBestScore();
      context.emit({ type: "runtime.ready", occurredAt: new Date().toISOString() });
    },

    hydrate(save: VectorSerializedSave | null) {
      // fromSaveData rejects corrupt or future-versioned saves outright, so a
      // null here means "fresh bests", never "half-restore". There is no
      // mid-flight state to restore by design (deterministicSeed: false — a
      // restart always starts over); the save carries cross-run bests only.
      best = (save ? fromSaveData(save.data) : null) ?? initialSaveData();
      renderHud();
    },

    start() {
      performStart();
    },

    pause() {
      running = false;
      // Drop held steering rather than the run: nothing is lost, but the
      // glider cannot drift into a wall while the game is not being watched.
      releaseAll();
      needsRedraw = true;
      renderHud();
    },

    resume() {
      if (disposed || !simulation.run.alive) return;
      running = true;
      needsRedraw = true;
      renderHud();
    },

    serialize(): VectorSerializedSave {
      // No seed field: deterministicSeed is false and a run cannot resume, so
      // persisting the seed would promise a replay the game does not offer.
      return { schemaVersion: PAPER_GLIDER_SAVE_SCHEMA_VERSION, data: best };
    },

    reset() {
      performReset();
    },

    updateSettings(next: VectorRuntimeSettings) {
      settings = next;
      // Motion preference changes camera tracking and glider attitude, so the
      // current frame is stale even though nothing in the run moved. Flag a
      // redraw rather than rendering synchronously off the scheduler's clock.
      needsRedraw = true;
    },

    handleContextLoss() {
      // Stop stepping immediately. Drawing into a lost context is what turns
      // a recoverable blip into a stream of console errors.
      contextLost = true;
      running = false;
      releaseAll();
      renderHud();
    },

    handleContextRestore() {
      contextLost = false;
      renderHud();
      // Draw AND present immediately: nothing else re-triggers a render while
      // paused, so without this the restored canvas would stay blank.
      needsRedraw = true;
      syncWorld();
      drawScene(1);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      running = false;

      unsubscribeScheduler?.();
      unsubscribeScheduler = null;
      listeners.abort();
      resizeObserver?.disconnect();
      resizeObserver = null;

      // Capture the canvas BEFORE nulling the renderer — the forced context
      // release below needs it after renderer.dispose().
      const canvas = renderer?.domElement ?? null;

      for (const index of [...roomGroups.keys()]) pruneRoomGroup(index);
      if (gliderMesh) {
        scene?.remove(gliderMesh);
        gliderMesh = null;
      }
      if (resources) {
        resources.unitBox.dispose();
        resources.roomEdges.dispose();
        resources.ringGeometry.dispose();
        resources.gliderGeometry.dispose();
        resources.wallMaterial.dispose();
        resources.furnitureMaterial.dispose();
        resources.ringMaterial.dispose();
        resources.ringCollectedMaterial.dispose();
        resources.gliderMaterial.dispose();
        resources.edgeMaterial.dispose();
        resources = null;
      }

      scene = null;
      camera = null;
      renderer?.dispose();
      // Belt and braces: browsers cap live WebGL contexts, and this component
      // remounts on every runtime retry. A context that outlives its canvas
      // exhausts that budget a few retries later, far from the cause —
      // renderer.dispose() releases GL programs but does not force the
      // context itself down.
      if (canvas) {
        const gl =
          (canvas.getContext("webgl2") as WebGLRenderingContext | null)
          ?? (canvas.getContext("webgl") as WebGLRenderingContext | null);
        gl?.getExtension("WEBGL_lose_context")?.loseContext();
      }
      renderer = null;
      three = null;

      context.mount.replaceChildren();
    },
  };

  return instance;
}

const paperGliderModule: VectorGameModule = {
  createGame: createPaperGliderGame,
};

export default paperGliderModule;
