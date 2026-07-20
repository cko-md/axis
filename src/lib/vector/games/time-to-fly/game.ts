/**
 * Time to Fly — the VECTOR orbital-launch shell (Wave 15.9).
 *
 * This file is the ONLY part of Time to Fly that touches Phaser or the DOM.
 * Everything that decides what is true — the flight, the slot lattice, the
 * solution set, elapsed time, the score transform — lives in the pure modules
 * beside it and is tested without a canvas. Phaser's job here is narrow and
 * deliberate: draw the state the simulation produced, and capture raw input.
 * It never simulates.
 *
 * Two consequences of that split are load-bearing and easy to undo by accident:
 *
 *  1. Arcade Physics is not enabled and must not be. `stepCraft` is the game's
 *     ground truth (see flight.ts) — a second physics system running alongside
 *     it would silently become the real authority the first time someone adds
 *     a sprite with a body, and the verifier's "this level has exactly two
 *     solutions" would stop being a statement about the game.
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
 * There is deliberately NO trajectory preview anywhere in this file. The spec
 * makes the flight something the player reasons about from planet positions
 * and visible outcomes, and the closest-approach feedback after a miss is the
 * entire learning surface. Drawing a predicted path — even a faint one — would
 * change the game, not the rendering.
 *
 * Artwork is deliberately absent. The registry keeps Time to Fly `planned`
 * until the design layer delivers real art; what draws below is neutral
 * placeholder geometry, and the palette is the seam where that work lands.
 */

import type {
  VectorGameCreateContext,
  VectorGameInstance,
  VectorGameModule,
  VectorRuntimeSettings,
  VectorSerializedSave,
} from "@/lib/vector/types";
import {
  TIME_TO_FLY_ARENA,
  TIME_TO_FLY_LEVEL_COUNT,
  TIME_TO_FLY_SLOT_UNITS,
  type TimeToFlyVector,
} from "@/lib/vector/games/time-to-fly/constants";
import {
  planetClassOf,
  planetPositionAt,
  reachRadius,
} from "@/lib/vector/games/time-to-fly/orbit";
import {
  type TimeToFlyLevel,
  generateTimeToFlyLevel,
} from "@/lib/vector/games/time-to-fly/level";
import { keyboardActionFor } from "@/lib/vector/games/time-to-fly/inputState";
import {
  TIME_TO_FLY_SAVE_SCHEMA_VERSION,
  type TimeToFlyRunState,
  fromPersistedScore,
  fromSaveData,
  initialRunState,
  levelsSolvedCount,
  runCompleted,
  selectLevel,
  toPersistedScore,
  toSaveData,
} from "@/lib/vector/games/time-to-fly/progress";
import {
  type TimeToFlySimulation,
  type TimeToFlyStepEvent,
  applyTimeToFlyInput,
  createTimeToFlySimulation,
  stepTimeToFlySimulation,
} from "@/lib/vector/games/time-to-fly/simulation";

const ROOT_CLASS = "vector-time-to-fly";

/** The camera's window onto the arena. Matches the manifest's landscape intent. */
const VIEWPORT = Object.freeze({ WIDTH: 960, HEIGHT: 540 });

/**
 * The whole arena stays on screen at a fixed zoom, always. A panning camera
 * would fight the aiming verb (the player drags planets anywhere on the
 * board), and a static frame is also the strongest reduced-motion posture:
 * there is no sustained camera translation to soften because there is none at
 * all.
 */
const WORLD_ZOOM = Math.min(
  VIEWPORT.WIDTH / TIME_TO_FLY_ARENA.WIDTH,
  VIEWPORT.HEIGHT / TIME_TO_FLY_ARENA.HEIGHT,
);

/**
 * Placeholder geometry colours. Not a design decision and not a token set —
 * Time to Fly stays `planned` in the registry precisely because this is where
 * real artwork has not landed yet.
 */
const PLACEHOLDER = Object.freeze({
  BACKGROUND: 0x0c0d12,
  ORBIT: 0x3a3d4d,
  SLOT_TICK: 0x565a70,
  FIELD: 0x2c3550,
  BODY: 0x9aa0b5,
  BODY_DRAGGING: 0xc6cbe0,
  SELECTION: 0x7d86a8,
  GALAXY: 0x8f7dc0,
  CRAFT: 0xe4e6f0,
  PAD: 0x4b7d5d,
});

/**
 * Visual-only radii. The simulation's SHIP_RADIUS (5 px) and GALAXY_RADIUS
 * (26 px) are collision truths, but at the fixed whole-arena zoom they render
 * about one and five screen pixels respectively — so the drawing uses larger
 * halos to stay visible. Nothing reads these back into the simulation.
 */
const CRAFT_DRAW_RADIUS = 16;
const GALAXY_HALO_RADIUS = 80;
const SLOT_TICK_RADIUS = 7;

const SCORE_MODE = "flight";

const SCENE_KEY = "time-to-fly";

function formatDuration(totalMs: number): string {
  const totalSeconds = Math.max(0, Math.round(totalMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function newSeed(): string {
  return globalThis.crypto?.randomUUID?.() ?? `time-to-fly-${Date.now()}`;
}

/**
 * Map a client-space pointer position to arena coordinates, through the FIT
 * letterbox and the fixed camera. Pure so the mapping itself is unit-testable
 * without a real canvas rect (jsdom reports every rect as zero, which this
 * treats as "no mapping" rather than a division by zero).
 */
export function mapClientPointToWorld(
  rect: Readonly<{ left: number; top: number; width: number; height: number }>,
  clientX: number,
  clientY: number,
): TimeToFlyVector | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  const viewX = ((clientX - rect.left) / rect.width) * VIEWPORT.WIDTH;
  const viewY = ((clientY - rect.top) / rect.height) * VIEWPORT.HEIGHT;
  return {
    x: TIME_TO_FLY_ARENA.WIDTH / 2 + (viewX - VIEWPORT.WIDTH / 2) / WORLD_ZOOM,
    y: TIME_TO_FLY_ARENA.HEIGHT / 2 + (viewY - VIEWPORT.HEIGHT / 2) / WORLD_ZOOM,
  };
}

export function createTimeToFlyGame(context: VectorGameCreateContext): VectorGameInstance {
  const doc = context.mount.ownerDocument ?? document;

  const root = doc.createElement("div");
  root.className = ROOT_CLASS;
  root.setAttribute("data-testid", "time-to-fly-root");
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
  // Functional, not cosmetic: without this a touch drag on the board scrolls
  // the page instead of moving a planet.
  surface.style.touchAction = "none";
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

  const levelField = hudField("time-to-fly-level", "Level");
  const solvedField = hudField("time-to-fly-solved", "Galaxies reached");
  const launchesField = hudField("time-to-fly-launches", "Launches");
  const elapsedField = hudField("time-to-fly-elapsed", "Elapsed");
  const bestField = hudField("time-to-fly-best", "Best");
  const statusField = hudField("time-to-fly-status", "Status");

  // The manifest promises planet properties and level state as DOM text; this
  // listing is that promise, rebuilt on every HUD render (at most five rows).
  const planetList = doc.createElement("div");
  planetList.className = `${ROOT_CLASS}__planets`;
  planetList.setAttribute("data-testid", "time-to-fly-planets");
  planetList.setAttribute("role", "group");
  planetList.setAttribute("aria-label", "Planets");
  root.appendChild(planetList);

  const levelBar = doc.createElement("div");
  levelBar.className = `${ROOT_CLASS}__levels`;
  levelBar.setAttribute("role", "group");
  levelBar.setAttribute("aria-label", "Levels");
  root.appendChild(levelBar);

  const levelButtons: HTMLButtonElement[] = [];
  for (let index = 0; index < TIME_TO_FLY_LEVEL_COUNT; index += 1) {
    const button = doc.createElement("button");
    button.type = "button";
    button.className = `${ROOT_CLASS}__level-button`;
    button.setAttribute("data-testid", `time-to-fly-select-level-${index + 1}`);
    button.textContent = `Level ${index + 1}`;
    levelBar.appendChild(button);
    levelButtons.push(button);
  }

  const touch = doc.createElement("div");
  touch.className = `${ROOT_CLASS}__touch`;
  root.appendChild(touch);

  // Real buttons, not canvas hit zones: this is what makes the manifest's
  // `input.touch` claim honest, and it gives the same controls to a keyboard
  // and to assistive technology for free. The continuous canvas drag is an
  // enhancement on top; every verb it performs is reachable from here.
  function touchButton(testId: string, label: string): HTMLButtonElement {
    const button = doc.createElement("button");
    button.type = "button";
    button.className = `${ROOT_CLASS}__touch-button`;
    button.setAttribute("data-testid", testId);
    button.setAttribute("aria-label", label);
    button.textContent = label;
    touch.appendChild(button);
    return button;
  }

  const prevPlanetButton = touchButton("time-to-fly-touch-prev", "Previous planet");
  const nextPlanetButton = touchButton("time-to-fly-touch-next", "Next planet");
  const rotateLeftButton = touchButton("time-to-fly-touch-rotate-left", "Rotate planet back one slot");
  const rotateRightButton = touchButton("time-to-fly-touch-rotate-right", "Rotate planet forward one slot");
  const launchButton = touchButton("time-to-fly-touch-launch", "Launch");

  let disposed = false;
  let settings: VectorRuntimeSettings = context.settings;
  let unsubscribeScheduler: (() => void) | null = null;
  const listeners = new AbortController();

  let run: TimeToFlyRunState = initialRunState(newSeed());

  /**
   * Levels are generated on demand and cached per index. Level 1 costs
   * single-digit milliseconds, but the four- and five-planet levels take
   * hundreds (the verifier's exhaustive count plus the player-model gate), so
   * generating all five eagerly would freeze initialize() for a board the
   * player may not reach this session.
   */
  let levelCacheSeed = run.runSeed;
  const levelCache = new Map<number, TimeToFlyLevel>();
  function levelFor(index: number): TimeToFlyLevel {
    if (levelCacheSeed !== run.runSeed) {
      levelCache.clear();
      levelCacheSeed = run.runSeed;
    }
    let level = levelCache.get(index);
    if (!level) {
      level = generateTimeToFlyLevel(run.runSeed, index);
      levelCache.set(index, level);
    }
    return level;
  }

  let simulation: TimeToFlySimulation = createTimeToFlySimulation(run, levelFor(run.levelIndex));
  /** The craft's position at the previous fixed step, for interpolation. */
  let previousCraftPos: TimeToFlyVector | null = null;
  let running = false;
  let startEmitted = false;
  /** Forces one more draw while nothing is in flight (aiming edits, pause, resume, reset, restore). */
  let needsRedraw = true;
  /** The best score as last read or recorded, so the display never re-reads mid-race. */
  let lastKnownBest: number | null = null;
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

  function announce(message: string): void {
    live.textContent = message;
  }

  function describeScore(score: number): string {
    const parts = fromPersistedScore(score);
    return parts.levelsSolved >= TIME_TO_FLY_LEVEL_COUNT
      ? `All ${TIME_TO_FLY_LEVEL_COUNT} levels in ${formatDuration(parts.elapsedMs)}`
      : `${parts.levelsSolved} of ${TIME_TO_FLY_LEVEL_COUNT} levels`;
  }

  function renderHud(): void {
    levelField.textContent = `${run.levelIndex + 1} of ${TIME_TO_FLY_LEVEL_COUNT}`;
    solvedField.textContent = `${levelsSolvedCount(run)} of ${TIME_TO_FLY_LEVEL_COUNT}`;
    launchesField.textContent = String(run.launches);
    elapsedField.textContent = formatDuration(run.elapsedMs);
    statusField.textContent = runCompleted(run)
      ? "All galaxies reached"
      : simulation.craft !== null
        ? running
          ? "In flight"
          : "Paused mid-flight"
        : running
          ? "Aiming"
          : "Ready";

    const rows: HTMLElement[] = [];
    simulation.level.planets.forEach((planet, index) => {
      const row = doc.createElement("p");
      row.className = `${ROOT_CLASS}__planet`;
      row.setAttribute("data-testid", `time-to-fly-planet-${index}`);
      const selected = simulation.input.selectedPlanet === index;
      const dragging = simulation.input.draggingPlanet === index;
      row.textContent =
        `Planet ${index + 1} of ${simulation.level.planets.length} — ${planet.planetClass}, `
        + (dragging ? "adjusting" : `slot ${simulation.input.arrangement[index]}`)
        + (selected ? ", selected" : "");
      rows.push(row);
    });
    planetList.replaceChildren(...rows);

    levelButtons.forEach((button, index) => {
      const current = index === run.levelIndex;
      const solved = run.solved[index] === true;
      button.setAttribute("aria-pressed", current ? "true" : "false");
      button.setAttribute("data-solved", solved ? "true" : "false");
      button.setAttribute(
        "aria-label",
        `Level ${index + 1}, ${solved ? "solved" : "unsolved"}${current ? ", current" : ""}`,
      );
    });
  }

  function renderBestField(): void {
    if (lastKnownBest === null) {
      bestField.textContent = "None yet";
      return;
    }
    bestField.textContent = describeScore(lastKnownBest);
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
        lastKnownBest = best;
        renderBestField();
      })
      .catch(() => {
        if (disposed) return;
        bestField.textContent = "Unavailable";
      });
  }

  /**
   * Fold a just-recorded value into the displayed best locally rather than
   * re-reading it. recordScore is asynchronous and goes through the sync
   * outbox, so an immediate read-back races it — and because the shared merge
   * is Math.max, the honest local update is the same maximum the store will
   * eventually hold.
   */
  function noteRecordedScore(value: number): void {
    if (!context.getBestScore) return;
    lastKnownBest = lastKnownBest === null ? value : Math.max(lastKnownBest, value);
    renderBestField();
  }

  function dispatch(action: Parameters<typeof applyTimeToFlyInput>[1]): void {
    const next = applyTimeToFlyInput(simulation, action);
    if (next === simulation) return;
    simulation = next;
    run = simulation.run;
    needsRedraw = true;
    renderHud();
  }

  function releaseAll(): void {
    dispatch({ type: "releaseAll" });
  }

  function nextUnsolvedIndex(): number | null {
    for (let offset = 1; offset <= TIME_TO_FLY_LEVEL_COUNT; offset += 1) {
      const index = (run.levelIndex + offset) % TIME_TO_FLY_LEVEL_COUNT;
      if (!run.solved[index]) return index;
    }
    return null;
  }

  function openLevel(index: number, emitStart: boolean): void {
    run = selectLevel(run, index);
    simulation = createTimeToFlySimulation(run, levelFor(index));
    previousCraftPos = null;
    needsRedraw = true;
    if (emitStart) {
      context.emit({
        type: "level.start",
        occurredAt: new Date().toISOString(),
        metadata: { level: index + 1 },
      });
    }
    renderHud();
  }

  function handleStepEvent(event: TimeToFlyStepEvent): void {
    if (event.type === "launch") {
      // The craft was just placed on the pad; interpolating from wherever the
      // last flight ended would streak it across the arena.
      previousCraftPos = simulation.craft?.position ?? null;
      announce(`Launch ${event.launches} away.`);
      return;
    }

    if (event.type === "arrival") {
      previousCraftPos = null;
      const value = toPersistedScore(run);
      context.emit({
        type: "level.complete",
        occurredAt: new Date().toISOString(),
        metadata: { level: event.levelIndex + 1 },
      });
      void context.recordScore?.({ mode: SCORE_MODE, challengeId: null, value });
      noteRecordedScore(value);

      if (event.runCompleted) {
        running = false;
        needsRedraw = true;
        context.emit({
          type: "run.complete",
          occurredAt: new Date().toISOString(),
          metadata: { mode: "solo", outcome: "complete", score: value, durationMs: run.elapsedMs },
        });
        announce(
          `Galaxy reached. All ${TIME_TO_FLY_LEVEL_COUNT} levels solved in ${formatDuration(run.elapsedMs)} across ${run.launches} ${run.launches === 1 ? "launch" : "launches"}.`,
        );
        return;
      }

      const next = nextUnsolvedIndex();
      if (next === null) return; // unreachable while !runCompleted, but never trust a flag over the data
      openLevel(next, true);
      announce(
        `Galaxy reached on level ${event.levelIndex + 1}. ${event.levelsSolved} of ${TIME_TO_FLY_LEVEL_COUNT} solved. Level ${next + 1} opened.`,
      );
      return;
    }

    // A miss. The board keeps the arrangement as launched (ADR-0006), and the
    // closest-approach number is the one piece of feedback the player learns
    // from — there is no trajectory preview to consult instead.
    previousCraftPos = null;
    needsRedraw = true;
    const approach = `Closest approach ${Math.round(event.closestApproach)} px from the galaxy.`;
    if (event.outcome === "crashed") {
      context.emit({
        type: "collision",
        occurredAt: new Date().toISOString(),
        metadata: { outcome: "collision" },
      });
      const target = event.crashedInto === null ? "a planet" : `planet ${event.crashedInto + 1}`;
      announce(`Crashed into ${target}. ${approach}`);
    } else if (event.outcome === "out-of-bounds") {
      announce(`Drifted out of bounds. ${approach}`);
    } else {
      announce(`The flight ran out of time. ${approach}`);
    }
  }

  function handleFrame(frame: { steps: number; nowMs: number; elapsedMs: number; alpha: number }): void {
    if (disposed) return;

    if (running) {
      for (let step = 0; step < frame.steps; step += 1) {
        if (simulation.craft) previousCraftPos = simulation.craft.position;
        const result = stepTimeToFlySimulation(simulation);
        simulation = result.simulation;
        run = simulation.run;
        for (const event of result.events) handleStepEvent(event);
      }
      renderHud();
    }

    // While the board is static — aiming with no pending edit, paused, or the
    // run left complete on screen — redrawing and stepping a full Phaser scene
    // at 60 Hz would burn a core to present an identical frame. One draw
    // settles the surface; after that the loop idles until a flight is in the
    // air or an input dirties the board.
    const flying = running && simulation.craft !== null;
    if (!flying && !needsRedraw) return;
    needsRedraw = false;

    drawWorld(frame.alpha);
    game?.step(frame.nowMs, frame.elapsedMs);
  }

  function drawWorld(alpha: number): void {
    // A local binding, because the null check must survive into the per-planet
    // closure below where TypeScript cannot carry the outer narrowing.
    const draw = graphics;
    if (!draw) return;

    draw.clear();

    // Launch pad — where every flight in every level begins.
    draw.fillStyle(PLACEHOLDER.PAD, 1);
    draw.fillCircle(TIME_TO_FLY_ARENA.LAUNCH_X, TIME_TO_FLY_ARENA.LAUNCH_Y, 22);

    const { planets } = simulation.level;
    const arrangement = simulation.input.arrangement;
    const dragVector = simulation.input.dragVector;

    planets.forEach((planet, index) => {
      const dragging = simulation.input.draggingPlanet === index;
      const selected = simulation.input.selectedPlanet === index;

      // A flight is flown against the placements frozen at launch; while one
      // is in the air, draw those, not the live board (the reducer blocks
      // edits mid-flight, so today they coincide — but the frozen set is the
      // truth and the drawing should read from it).
      const position = simulation.placed
        ? simulation.placed[index].position
        : dragging && dragVector
          ? {
              x: planet.orbitCenter.x + planet.orbitRadius * dragVector.x,
              y: planet.orbitCenter.y + planet.orbitRadius * dragVector.y,
            }
          : planetPositionAt(planet, arrangement[index] ?? 0);

      // The orbit ring is the rail the planet rides; the field disc is the
      // region where gravity acts. Both are the level's honest geometry.
      draw.lineStyle(6, PLACEHOLDER.ORBIT, 0.7);
      draw.strokeCircle(planet.orbitCenter.x, planet.orbitCenter.y, planet.orbitRadius);

      if (selected) {
        // Slot ticks only on the selected planet: twelve lattice positions,
        // drawn from the hardcoded unit table — no trigonometry, even here.
        draw.fillStyle(PLACEHOLDER.SLOT_TICK, 0.9);
        for (const unit of TIME_TO_FLY_SLOT_UNITS) {
          draw.fillCircle(
            planet.orbitCenter.x + planet.orbitRadius * unit.x,
            planet.orbitCenter.y + planet.orbitRadius * unit.y,
            SLOT_TICK_RADIUS,
          );
        }
      }

      // Field and body radii come from the class table — the same numbers the
      // simulation collides against, never a second copy.
      const spec = planetClassOf(planet);

      draw.fillStyle(PLACEHOLDER.FIELD, 0.35);
      draw.fillCircle(position.x, position.y, spec.fieldRadius);

      draw.fillStyle(dragging ? PLACEHOLDER.BODY_DRAGGING : PLACEHOLDER.BODY, 1);
      draw.fillCircle(position.x, position.y, spec.bodyRadius);

      if (selected && !simulation.placed) {
        draw.lineStyle(5, PLACEHOLDER.SELECTION, 1);
        draw.strokeCircle(position.x, position.y, spec.bodyRadius + 14);
      }
    });

    // The galaxy: the true capture disc plus a visual halo (see the
    // draw-radius note above).
    const galaxy = simulation.level.galaxy;
    draw.fillStyle(PLACEHOLDER.GALAXY, 0.25);
    draw.fillCircle(galaxy.x, galaxy.y, GALAXY_HALO_RADIUS);
    draw.fillStyle(PLACEHOLDER.GALAXY, 1);
    draw.fillCircle(galaxy.x, galaxy.y, TIME_TO_FLY_ARENA.GALAXY_RADIUS);

    const craft = simulation.craft;
    if (craft) {
      // Interpolate between the last two fixed steps so the craft reads
      // smoothly on displays faster than the 60 Hz simulation rate. Reduced
      // motion draws the discrete step positions instead — the flight's
      // semantics are untouched either way, only the in-between frames change.
      const drawAt = settings.resolvedMotion === "reduced" || !previousCraftPos
        ? craft.position
        : {
            x: previousCraftPos.x + (craft.position.x - previousCraftPos.x) * alpha,
            y: previousCraftPos.y + (craft.position.y - previousCraftPos.y) * alpha,
          };
      draw.fillStyle(PLACEHOLDER.CRAFT, 1);
      draw.fillCircle(drawAt.x, drawAt.y, CRAFT_DRAW_RADIUS);
    }
  }

  function worldFromPointer(event: { clientX: number; clientY: number }): TimeToFlyVector | null {
    const canvas = game?.canvas;
    if (!canvas) return null;
    return mapClientPointToWorld(canvas.getBoundingClientRect(), event.clientX, event.clientY);
  }

  /**
   * Which planet a pointer at `world` grabs, or null. The grab region is the
   * planet's whole reach disc — generous under a finger, and unambiguous by
   * construction, because ADR-0006 guarantees reach discs never overlap.
   */
  function planetIndexAt(world: TimeToFlyVector): number | null {
    for (let index = 0; index < simulation.level.planets.length; index += 1) {
      const planet = simulation.level.planets[index];
      const dx = world.x - planet.orbitCenter.x;
      const dy = world.y - planet.orbitCenter.y;
      const radius = reachRadius(planet);
      if (dx * dx + dy * dy <= radius * radius) return index;
    }
    return null;
  }

  function switchLevel(index: number): void {
    if (index === run.levelIndex) return;
    if (simulation.craft !== null) {
      announce("Wait for the flight to resolve before changing levels.");
      return;
    }
    openLevel(index, startEmitted);
    announce(`Level ${index + 1} opened.`);
  }

  function attachInput(): void {
    const { signal } = listeners;

    // Bind to the HOST'S MOUNT, not to `root`.
    //
    // The mount is the element GameRuntimeHost makes focusable (tabIndex={0})
    // and explicitly focuses on resume and restart. `root` is its child with
    // tabIndex=-1, so a keydown dispatched at the focused mount never
    // propagates down into it — Brickrise shipped that bug once: binding on
    // the inner root made the game unplayable by keyboard while every unit
    // test passed, because the tests dispatched on a target that never occurs
    // in production.
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
    // No keyup listener on purpose: every keyboard verb in this game is a
    // discrete press (keyboardActionFor returns null for the "up" phase), so
    // a keyup handler would be dead code claiming events it never uses.

    // The continuous drag. Pointer events unify mouse and touch, and capture
    // keeps a thumb that slides off the board delivering its release here
    // rather than leaving a drag latched open.
    let dragPointerId: number | null = null;

    surface.addEventListener(
      "pointerdown",
      (event) => {
        if (dragPointerId !== null) return;
        const world = worldFromPointer(event);
        if (!world) return;
        const planetIndex = planetIndexAt(world);
        if (planetIndex === null) return;
        event.preventDefault();
        dragPointerId = event.pointerId;
        surface.setPointerCapture?.(event.pointerId);
        const centre = simulation.level.planets[planetIndex].orbitCenter;
        dispatch({
          type: "dragStart",
          planetIndex,
          offset: { x: world.x - centre.x, y: world.y - centre.y },
        });
      },
      { signal },
    );

    surface.addEventListener(
      "pointermove",
      (event) => {
        if (event.pointerId !== dragPointerId) return;
        const dragging = simulation.input.draggingPlanet;
        if (dragging === null) return;
        const world = worldFromPointer(event);
        if (!world) return;
        const centre = simulation.level.planets[dragging].orbitCenter;
        dispatch({ type: "dragMove", offset: { x: world.x - centre.x, y: world.y - centre.y } });
      },
      { signal },
    );

    surface.addEventListener(
      "pointerup",
      (event) => {
        if (event.pointerId !== dragPointerId) return;
        dragPointerId = null;
        // Release commits the drag to its nearest slot — the one moment the
        // continuous gesture becomes discrete state.
        dispatch({ type: "dragEnd" });
      },
      { signal },
    );

    for (const type of ["pointercancel", "lostpointercapture"] as const) {
      surface.addEventListener(
        type,
        (event) => {
          if (event.pointerId !== dragPointerId) return;
          dragPointerId = null;
          dispatch({ type: "dragCancel" });
        },
        { signal },
      );
    }

    prevPlanetButton.addEventListener("click", () => dispatch({ type: "cycleSelection", direction: -1 }), { signal });
    nextPlanetButton.addEventListener("click", () => dispatch({ type: "cycleSelection", direction: 1 }), { signal });
    rotateLeftButton.addEventListener("click", () => dispatch({ type: "rotateSelected", direction: -1 }), { signal });
    rotateRightButton.addEventListener("click", () => dispatch({ type: "rotateSelected", direction: 1 }), { signal });
    launchButton.addEventListener("click", () => dispatch({ type: "launch" }), { signal });

    levelButtons.forEach((button, index) => {
      button.addEventListener("click", () => switchLevel(index), { signal });
    });

    // Losing focus or visibility mid-gesture must not leave a drag latched or
    // a launch edge armed to fire when the player is not looking.
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
          // Escape, and pointer capture all belong to the host and this file.
          input: { keyboard: false, mouse: false, touch: false, gamepad: false },
          // No `physics` key. stepCraft is the only physics in this game.
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
        scene.cameras.main.setZoom(WORLD_ZOOM);
        scene.cameras.main.centerOn(TIME_TO_FLY_ARENA.WIDTH / 2, TIME_TO_FLY_ARENA.HEIGHT / 2);
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
      simulation = createTimeToFlySimulation(run, levelFor(run.levelIndex));
      previousCraftPos = null;
      needsRedraw = true;
      renderHud();
    },

    start() {
      if (runCompleted(run)) return;
      running = true;
      releaseAll();
      if (!startEmitted) {
        startEmitted = true;
        context.emit({
          type: "run.start",
          occurredAt: new Date().toISOString(),
          metadata: { mode: "solo" },
        });
        context.emit({
          type: "level.start",
          occurredAt: new Date().toISOString(),
          metadata: { level: run.levelIndex + 1 },
        });
      }
      announce(
        `Level ${run.levelIndex + 1} of ${TIME_TO_FLY_LEVEL_COUNT}. Arrange the ${simulation.level.planets.length === 1 ? "planet" : "planets"}, then launch.`,
      );
      renderHud();
    },

    pause() {
      running = false;
      // Drop transient input — an armed launch edge or a mid-air drag — but
      // never the board or a flight in progress: nothing about the run is
      // lost, and nothing can move while the game is not being watched.
      releaseAll();
      needsRedraw = true;
      renderHud();
    },

    resume() {
      if (runCompleted(run)) return;
      running = true;
      needsRedraw = true;
      renderHud();
    },

    serialize(): VectorSerializedSave {
      return {
        schemaVersion: TIME_TO_FLY_SAVE_SCHEMA_VERSION,
        data: toSaveData(run),
        seed: run.runSeed,
      };
    },

    reset() {
      running = false;
      startEmitted = false;
      // A restart re-rolls the run. Stability of starting positions is a
      // promise about retries WITHIN a run (the seed persists across saves);
      // an explicit restart is a new expedition with new levels.
      run = initialRunState(newSeed());
      simulation = createTimeToFlySimulation(run, levelFor(run.levelIndex));
      previousCraftPos = null;
      needsRedraw = true;
      renderHud();
      announce("Run reset. Five fresh levels await.");
    },

    updateSettings(next: VectorRuntimeSettings) {
      settings = next;
      // Motion preference changes how the craft is drawn between fixed steps,
      // so the current frame is now stale even though nothing in the run moved.
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

export const timeToFlyGameModule: VectorGameModule = {
  createGame: createTimeToFlyGame,
};

export default timeToFlyGameModule;
