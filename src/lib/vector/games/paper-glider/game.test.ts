// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  VectorGameCreateContext,
  VectorGameInstance,
  VectorRuntimeEvent,
  VectorRuntimeFrame,
} from "@/lib/vector/types";
import { DEFAULT_VECTOR_RUNTIME_SETTINGS } from "@/lib/vector/types";
import { requireVectorGame } from "@/lib/vector/registry";
import { sanitizeVectorRuntimeEvent } from "@/lib/vector/runtime";
import {
  initialSaveData,
  PAPER_GLIDER_SAVE_SCHEMA_VERSION,
  PAPER_GLIDER_SCORE,
  type PaperGliderCollisionReason,
} from "@/lib/vector/games/paper-glider/progress";
import { roomAtDistance } from "@/lib/vector/games/paper-glider/level";
import {
  INITIAL_PAPER_GLIDER_INPUT,
  reducePaperGliderInput,
  steerTargetFrom,
} from "@/lib/vector/games/paper-glider/inputState";
import {
  createPaperGliderSimulation,
  stepPaperGliderSimulation,
} from "@/lib/vector/games/paper-glider/simulation";

/**
 * Paper Glider's shell is the one part of the game that needs an engine and a
 * canvas, so Three is replaced here with a recording double. That is not a
 * shortcut around the real thing: the flight rules are already covered by the
 * physics/level/progress/simulation tests and the completability sweep, and
 * what remains to prove about this file is exactly the orchestration a double
 * can observe — that the VECTOR scheduler (not Three) drives the simulation,
 * that input reaches the state machine through the host's mount, that every
 * listener, geometry, material, and the WebGL context are released on dispose,
 * and that nothing fake ever reaches the DOM or the event sanitizer.
 */

const loseContext = vi.fn();
const rendererDispose = vi.fn();
const renderSpy = vi.fn();

let createdRenderers = 0;
let capturedCanvas: HTMLCanvasElement | null = null;
let createdScenes: FakeScene[] = [];
let createdCameras: FakeCamera[] = [];
let createdGeometries: FakeGeometry[] = [];
let createdMaterials: FakeMaterial[] = [];
let resizeObservers: FakeResizeObserver[] = [];

class FakeVec {
  x = 0;
  y = 0;
  z = 0;
  set(x: number, y: number, z: number): this {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }
}

class FakeObject3D {
  name = "";
  position = new FakeVec();
  rotation = new FakeVec();
  scale = new FakeVec();
  children: FakeObject3D[] = [];
  add(child: FakeObject3D): this {
    this.children.push(child);
    return this;
  }
  remove(child: FakeObject3D): this {
    this.children = this.children.filter((entry) => entry !== child);
    return this;
  }
}

class FakeGeometry {
  dispose = vi.fn();
  constructor() {
    createdGeometries.push(this);
  }
  setAttribute(): void {}
  computeVertexNormals(): void {}
}

class FakeMaterial {
  dispose = vi.fn();
  constructor() {
    createdMaterials.push(this);
  }
}

class FakeMesh extends FakeObject3D {
  constructor(
    public geometry?: unknown,
    public material?: unknown,
  ) {
    super();
  }
}

class FakeCamera extends FakeObject3D {
  aspect = 1;
  updateProjectionMatrix = vi.fn();
  lookAt = vi.fn();
  constructor() {
    super();
    createdCameras.push(this);
  }
}

class FakeScene extends FakeObject3D {
  background: unknown = null;
  constructor() {
    super();
    createdScenes.push(this);
  }
}

class FakeRenderer {
  domElement: HTMLCanvasElement;
  setPixelRatio = vi.fn();
  setSize = vi.fn();
  render = renderSpy;
  dispose = rendererDispose;
  constructor() {
    createdRenderers += 1;
    this.domElement = document.createElement("canvas");
    capturedCanvas = this.domElement;
    // A real WebGL context is unavailable in jsdom; expose just the surface
    // dispose() reaches for.
    this.domElement.getContext = vi.fn(() => ({
      getExtension: () => ({ loseContext }),
    })) as unknown as HTMLCanvasElement["getContext"];
  }
}

class FakeResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  constructor() {
    resizeObservers.push(this);
  }
}

vi.mock("three", () => ({
  WebGLRenderer: FakeRenderer,
  Scene: FakeScene,
  PerspectiveCamera: FakeCamera,
  Color: class {},
  Group: class extends FakeObject3D {},
  Mesh: FakeMesh,
  LineSegments: class extends FakeObject3D {
    constructor(
      public geometry?: unknown,
      public material?: unknown,
    ) {
      super();
    }
  },
  BoxGeometry: FakeGeometry,
  EdgesGeometry: FakeGeometry,
  TorusGeometry: FakeGeometry,
  BufferGeometry: FakeGeometry,
  Float32BufferAttribute: class {},
  MeshBasicMaterial: FakeMaterial,
  LineBasicMaterial: FakeMaterial,
  DoubleSide: 2,
}));

// The flight rules that decide when a collision or ring event fires are
// exhaustively covered by simulation.test.ts and the completability sweep.
// Wrapping the real step function lets a specific test queue a canned event
// with mockImplementationOnce, so what gets proven here is exactly this
// file's job: reacting correctly to an event, not producing one.
vi.mock("@/lib/vector/games/paper-glider/simulation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/vector/games/paper-glider/simulation")>();
  return { ...actual, stepPaperGliderSimulation: vi.fn(actual.stepPaperGliderSimulation) };
});

/** jsdom does not implement PointerEvent; this carries the fields the shell reads. */
function pointer(
  type: string,
  init: { pointerId?: number; pointerType?: string; clientX?: number; clientY?: number } = {},
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "pointerId", { value: init.pointerId ?? 1 });
  Object.defineProperty(event, "pointerType", { value: init.pointerType ?? "mouse" });
  Object.defineProperty(event, "clientX", { value: init.clientX ?? 0 });
  Object.defineProperty(event, "clientY", { value: init.clientY ?? 0 });
  return event;
}

function findByName(node: FakeObject3D, name: string): FakeObject3D | null {
  if (node.name === name) return node;
  for (const child of node.children) {
    const found = findByName(child, name);
    if (found) return found;
  }
  return null;
}

function glider(): FakeObject3D {
  const scene = createdScenes.at(-1);
  const mesh = scene ? findByName(scene, "paper-glider-body") : null;
  if (!mesh) throw new Error("glider mesh not found in the mocked scene");
  return mesh;
}

function camera(): FakeCamera {
  const latest = createdCameras.at(-1);
  if (!latest) throw new Error("camera not found in the mocked scene");
  return latest;
}

type Harness = {
  instance: VectorGameInstance;
  mount: HTMLElement;
  events: VectorRuntimeEvent[];
  emitFrame: (overrides?: Partial<VectorRuntimeFrame>) => void;
  recordScore: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  /**
   * Every callback ever passed to scheduler.subscribe, in order, INDEPENDENT
   * of unsubscription. `emitFrame` models the ordinary case (the scheduler
   * stops delivering once unsubscribed); this models the race it cannot — a
   * frame already in flight when dispose() unsubscribed, which the game must
   * absorb inertly rather than crash on.
   */
  rawListeners: Array<(frame: VectorRuntimeFrame) => void>;
  context: VectorGameCreateContext;
};

function buildContext(overrides: Partial<VectorGameCreateContext> = {}): {
  context: VectorGameCreateContext;
  events: VectorRuntimeEvent[];
  emitFrame: Harness["emitFrame"];
  recordScore: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  rawListeners: Harness["rawListeners"];
} {
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  // jsdom reports a zero-size rect, which the pointer normalizer rightly
  // refuses to divide by; give the mount a real steering surface.
  vi.spyOn(mount, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 800,
    bottom: 450,
    width: 800,
    height: 450,
    toJSON: () => ({}),
  } as DOMRect);

  const events: VectorRuntimeEvent[] = [];
  let listener: ((frame: VectorRuntimeFrame) => void) | null = null;
  const rawListeners: Harness["rawListeners"] = [];
  const unsubscribe = vi.fn(() => {
    listener = null;
  });
  const recordScore = vi.fn();

  const context: VectorGameCreateContext = {
    mount,
    manifest: requireVectorGame("paper-glider"),
    settings: DEFAULT_VECTOR_RUNTIME_SETTINGS,
    scheduler: {
      subscribe: (next) => {
        listener = next;
        rawListeners.push(next);
        return unsubscribe;
      },
      start: vi.fn(),
      stop: vi.fn(),
      dispose: vi.fn(),
      isRunning: () => true,
    },
    emit: (event) => events.push(event),
    recordScore,
    getBestScore: async () => null,
    ...overrides,
  };

  return {
    context,
    events,
    recordScore,
    unsubscribe,
    rawListeners,
    emitFrame: (frameOverrides = {}) =>
      listener?.({
        nowMs: 0,
        steps: 1,
        stepMs: 1000 / 60,
        elapsedMs: 1000 / 60,
        droppedMs: 0,
        alpha: 1,
        ...frameOverrides,
      }),
  };
}

async function mountGame(overrides: Partial<VectorGameCreateContext> = {}): Promise<Harness> {
  const { createPaperGliderGame } = await import("@/lib/vector/games/paper-glider/game");
  const built = buildContext(overrides);
  const instance = createPaperGliderGame(built.context);
  await instance.initialize();
  return {
    instance,
    mount: built.context.mount,
    events: built.events,
    emitFrame: built.emitFrame,
    recordScore: built.recordScore,
    unsubscribe: built.unsubscribe,
    rawListeners: built.rawListeners,
    context: built.context,
  };
}

function textOf(mount: HTMLElement, testId: string): string {
  return mount.querySelector(`[data-testid="${testId}"]`)?.textContent ?? "";
}

/** Makes the next real step report a collision, without scripting a real flight. */
function queueCollision(reason: PaperGliderCollisionReason, distance: number, score: number): void {
  vi.mocked(stepPaperGliderSimulation).mockImplementationOnce((simulation) => {
    const run = { ...simulation.run, distance, alive: false, collisionReason: reason };
    return {
      simulation: { ...simulation, run },
      events: [{ type: "collision", reason, distance, score }],
    };
  });
}

/** Makes the next real step report a collected ring. */
function queueRing(): void {
  vi.mocked(stepPaperGliderSimulation).mockImplementationOnce((simulation) => {
    const run = {
      ...simulation.run,
      ringsCollected: simulation.run.ringsCollected + 1,
      collectedRingKeys: [...simulation.run.collectedRingKeys, "1:0"],
    };
    return {
      simulation: { ...simulation, run },
      events: [{ type: "ring", roomIndex: 1, ringIndex: 0, total: 1 }],
    };
  });
}

/** Drains the microtask queue so a chained getBestScore().then(...) settles. */
async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * The exact simulation the shell must reproduce: the same seed stepped through
 * the same per-frame entry point with the same hold-course target the shell
 * derives when no input is active. Any analytic fast-forward, second clock, or
 * re-implemented motion in the shell diverges from this immediately.
 */
function pureSimAfterSteps(seed: string, steps: number) {
  let sim = createPaperGliderSimulation(seed);
  for (let i = 0; i < steps; i += 1) {
    sim = stepPaperGliderSimulation(sim, { x: sim.body.x, y: sim.body.y }).simulation;
  }
  return sim;
}

const FIXED_SEED = "paper-glider-test-seed-0";
let seedCounter = 0;

beforeEach(() => {
  createdRenderers = 0;
  capturedCanvas = null;
  createdScenes = [];
  createdCameras = [];
  createdGeometries = [];
  createdMaterials = [];
  resizeObservers = [];
  seedCounter = 0;
  vi.clearAllMocks();
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  // Deterministic seeds: the first run gets FIXED_SEED, each reset a fresh one.
  vi.stubGlobal("crypto", {
    randomUUID: () => {
      const seed = `paper-glider-test-seed-${seedCounter}`;
      seedCounter += 1;
      return seed;
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("Paper Glider shell", () => {
  describe("boot", () => {
    it("boots Three and reports runtime readiness", async () => {
      const harness = await mountGame();

      expect(createdRenderers).toBe(1);
      expect(harness.events.map((event) => event.type)).toContain("runtime.ready");
      expect(harness.mount.querySelector('[data-testid="paper-glider-root"]')).not.toBeNull();
    });

    it("hides the canvas from assistive technology; DOM text carries the state", async () => {
      const harness = await mountGame();

      expect(capturedCanvas?.parentElement?.getAttribute("aria-hidden")).toBe("true");
      // The manifest's accessibilityDescription promises score, speed, and the
      // collision result outside WebGL; these are those.
      for (const testId of [
        "paper-glider-score",
        "paper-glider-distance",
        "paper-glider-rings",
        "paper-glider-speed",
        "paper-glider-status",
        "paper-glider-result",
        "paper-glider-best",
      ]) {
        expect(harness.mount.querySelector(`[data-testid="${testId}"]`), testId).not.toBeNull();
      }
      const live = harness.mount.querySelector('[role="status"]');
      expect(live?.getAttribute("aria-live")).toBe("polite");
    });

    it("never runs its own animation loop — the VECTOR scheduler is the only clock", async () => {
      await mountGame();
      const source = await import("node:fs").then((fs) =>
        fs.readFileSync("src/lib/vector/games/paper-glider/game.ts", "utf8"),
      );
      expect(source).not.toMatch(/setAnimationLoop/);
      expect(source).not.toMatch(/requestAnimationFrame/);
    });
  });

  describe("the scheduler drives the simulation (not Three)", () => {
    it("does not advance before start()", async () => {
      const harness = await mountGame();

      harness.emitFrame({ steps: 10 });

      expect(textOf(harness.mount, "paper-glider-distance")).toBe("0");
    });

    it("advances exactly the number of fixed steps the frame reports, matching the pure core step for step", async () => {
      const expected = pureSimAfterSteps(FIXED_SEED, 60);
      // Precondition, not an assertion about the shell: the reference flight
      // itself must still be alive or the comparison would prove less.
      expect(expected.run.alive).toBe(true);

      const harness = await mountGame();
      await harness.instance.hydrate(null);
      await harness.instance.start();

      // 60 steps in one frame; the wall-clock time the frame claims is
      // irrelevant to how far the flight advances.
      harness.emitFrame({ steps: 60, elapsedMs: 999_999 });

      expect(textOf(harness.mount, "paper-glider-distance")).toBe(
        String(Math.round(expected.run.distance)),
      );
      expect(textOf(harness.mount, "paper-glider-score")).toBe(
        String(Math.round(expected.run.distance)),
      );
    });

    it("blends the drawn position between the previous and current fixed step by the frame's alpha", async () => {
      // At alpha = 1 the blend `prev + (body - prev) * alpha` collapses to
      // `body` for ANY prev — so every alpha-1 test in this file would keep
      // passing even if previousBody tracking rotted (captured after the step,
      // never updated, or dropped entirely). A fractional alpha is the only
      // observation that makes prev load-bearing.
      const heldRight = reducePaperGliderInput(INITIAL_PAPER_GLIDER_INPUT, { type: "keyDown", key: "right" });
      function pureSimSteeredRight(steps: number) {
        // The same seed stepped with the exact target the shell derives from a
        // held ArrowRight (steerTargetFrom tracks the live body, so it must be
        // re-derived each step, exactly as the shell does).
        let sim = createPaperGliderSimulation(FIXED_SEED);
        for (let i = 0; i < steps; i += 1) {
          sim = stepPaperGliderSimulation(sim, steerTargetFrom(heldRight, sim.body)).simulation;
        }
        return sim;
      }
      const prev = pureSimSteeredRight(5).body;
      const current = pureSimSteeredRight(6).body;
      // Preconditions: the bracketing states genuinely differ on every axis
      // asserted below, or the midpoint check would prove nothing.
      expect(current.x).not.toBe(prev.x);
      expect(current.z).not.toBe(prev.z);

      const harness = await mountGame();
      await harness.instance.hydrate(null);
      await harness.instance.start();
      harness.mount.dispatchEvent(new KeyboardEvent("keydown", { code: "ArrowRight", bubbles: true }));
      harness.emitFrame({ steps: 5, alpha: 1 });

      harness.emitFrame({ steps: 1, alpha: 0.5 });

      const drawn = glider().position;
      expect(drawn.x).toBeCloseTo(prev.x + (current.x - prev.x) * 0.5, 12);
      expect(drawn.y).toBeCloseTo(prev.y + (current.y - prev.y) * 0.5, 12);
      expect(drawn.z).toBeCloseTo(prev.z + (current.z - prev.z) * 0.5, 12);
      // And distinctly NOT a snap to either endpoint — the failure shapes a
      // broken previousBody would produce.
      expect(drawn.x).not.toBe(current.x);
      expect(drawn.z).not.toBe(prev.z);
    });

    it("stops advancing while paused and resumes exactly where it left off", async () => {
      const harness = await mountGame();
      await harness.instance.hydrate(null);
      await harness.instance.start();
      harness.emitFrame({ steps: 30 });
      const beforePause = textOf(harness.mount, "paper-glider-distance");
      await harness.instance.pause("visibility");

      harness.emitFrame({ steps: 600 });
      expect(textOf(harness.mount, "paper-glider-distance")).toBe(beforePause);

      await harness.instance.resume();
      harness.emitFrame({ steps: 30 });
      expect(textOf(harness.mount, "paper-glider-distance")).toBe(
        String(Math.round(pureSimAfterSteps(FIXED_SEED, 60).run.distance)),
      );
    });

    it("settles to an idle surface when paused rather than re-rendering at 60 Hz", async () => {
      const harness = await mountGame();
      await harness.instance.hydrate(null);
      await harness.instance.start();
      // A running frame FIRST, so the initial needsRedraw flag from
      // construction is consumed before pause() runs — otherwise the settling
      // draw below could come from leftover initial state and this test would
      // stay green with pause()'s own redraw request deleted.
      harness.emitFrame({ steps: 1 });
      const beforePause = renderSpy.mock.calls.length;
      await harness.instance.pause("user");

      // Exactly one settling frame — pause() must request it, or a paused
      // surface freezes on whatever half-state the last running frame drew.
      harness.emitFrame();
      expect(renderSpy.mock.calls.length).toBe(beforePause + 1);

      // After settling, a paused run must not keep driving a full scene
      // render per frame.
      const afterSettle = renderSpy.mock.calls.length;
      harness.emitFrame();
      harness.emitFrame();
      expect(renderSpy.mock.calls.length).toBe(afterSettle);
    });
  });

  describe("input", () => {
    it("claims steering keys dispatched at the host's mount", async () => {
      const harness = await mountGame();

      // Dispatch on the MOUNT, not on the game's own root: the host focuses
      // the mount, so this is the only target that occurs in production.
      const event = new KeyboardEvent("keydown", { code: "ArrowRight", cancelable: true, bubbles: true });
      harness.mount.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
    });

    it("steers the flight from the keyboard", async () => {
      const harness = await mountGame();
      await harness.instance.hydrate(null);
      await harness.instance.start();

      harness.mount.dispatchEvent(new KeyboardEvent("keydown", { code: "ArrowRight", bubbles: true }));
      harness.emitFrame({ steps: 10, alpha: 1 });

      expect(glider().position.x).toBeGreaterThan(0);
    });

    it("leaves Tab and Escape to the browser and the host (WCAG 2.1.2)", async () => {
      const harness = await mountGame();

      for (const code of ["Tab", "Escape"]) {
        const event = new KeyboardEvent("keydown", { code, cancelable: true, bubbles: true });
        harness.mount.dispatchEvent(event);
        expect(event.defaultPrevented, code).toBe(false);
      }
    });

    it("steers by mouse hover position over the mount", async () => {
      const harness = await mountGame();
      await harness.instance.hydrate(null);
      await harness.instance.start();

      // Pointer at 60% width: right of centre, so the glider must drift +x.
      harness.mount.dispatchEvent(
        pointer("pointermove", { pointerType: "mouse", clientX: 480, clientY: 225 }),
      );
      harness.emitFrame({ steps: 10, alpha: 1 });

      expect(glider().position.x).toBeGreaterThan(0);
    });

    it("gives touch steering to the first touch and does not let a second finger steal it", async () => {
      const harness = await mountGame();
      await harness.instance.hydrate(null);
      await harness.instance.start();

      // A stray move from an unclaimed touch must not steer at all.
      harness.mount.dispatchEvent(
        pointer("pointermove", { pointerType: "touch", pointerId: 9, clientX: 480, clientY: 225 }),
      );
      harness.emitFrame({ steps: 5, alpha: 1 });
      expect(glider().position.x).toBe(0);

      harness.mount.dispatchEvent(
        pointer("pointerdown", { pointerType: "touch", pointerId: 1, clientX: 480, clientY: 225 }),
      );
      // A second finger touching elsewhere must not move the steer left.
      harness.mount.dispatchEvent(
        pointer("pointerdown", { pointerType: "touch", pointerId: 2, clientX: 80, clientY: 225 }),
      );
      harness.emitFrame({ steps: 10, alpha: 1 });

      expect(glider().position.x).toBeGreaterThan(0);
    });

    it("holds course when the steering touch lifts", async () => {
      const harness = await mountGame();
      await harness.instance.hydrate(null);
      await harness.instance.start();

      harness.mount.dispatchEvent(
        pointer("pointerdown", { pointerType: "touch", pointerId: 1, clientX: 520, clientY: 225 }),
      );
      harness.emitFrame({ steps: 8, alpha: 1 });
      harness.mount.dispatchEvent(pointer("pointerup", { pointerType: "touch", pointerId: 1 }));

      // Lateral velocity decays to exactly zero under the hold-course target
      // (bounded deceleration, at most 12 steps from top speed)…
      harness.emitFrame({ steps: 30, alpha: 1 });
      const settled = glider().position.x;
      // …after which the glider flies straight: more steps, same x.
      harness.emitFrame({ steps: 20, alpha: 1 });
      expect(glider().position.x).toBe(settled);
    });

    it("releases held steering when focus leaves the mount", async () => {
      const harness = await mountGame();
      await harness.instance.hydrate(null);
      harness.mount.dispatchEvent(new KeyboardEvent("keydown", { code: "ArrowRight", bubbles: true }));

      // focusout, not blur — blur does not bubble, so a blur listener on the
      // mount would never fire for focus leaving a descendant.
      harness.mount.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));

      await harness.instance.start();
      harness.emitFrame({ steps: 10, alpha: 1 });
      // The key was released before any step ran, so no lateral velocity ever
      // accrued — with the release missing, this drifts exactly like the
      // keyboard-steering test above.
      expect(glider().position.x).toBe(0);
    });

    it("releases held steering when the document is hidden", async () => {
      const harness = await mountGame();
      await harness.instance.hydrate(null);
      harness.mount.dispatchEvent(new KeyboardEvent("keydown", { code: "ArrowRight", bubbles: true }));

      vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      document.dispatchEvent(new Event("visibilitychange"));

      await harness.instance.start();
      harness.emitFrame({ steps: 10, alpha: 1 });
      expect(glider().position.x).toBe(0);
    });
  });

  describe("run events surface honestly", () => {
    it("surfaces a collected ring in the HUD, the live region, and a score.updated event", async () => {
      const harness = await mountGame();
      await harness.instance.hydrate(null);
      await harness.instance.start();

      queueRing();
      harness.emitFrame({ steps: 1 });

      expect(textOf(harness.mount, "paper-glider-rings")).toBe("1");
      // The ring BONUS must reach the displayed score, not just the ring
      // counter: distance is 0 here, so the score field isolates the
      // RING_BONUS term outright (every other score assertion in this file
      // runs at zero rings, where score degenerates to rounded distance).
      expect(textOf(harness.mount, "paper-glider-score")).toBe(String(PAPER_GLIDER_SCORE.RING_BONUS));
      expect(harness.events.map((event) => event.type)).toContain("score.updated");
      expect(harness.mount.querySelector('[role="status"]')?.textContent).toMatch(/Ring collected/);
    });

    it("ends the run on collision: result text, events, and the recorded score", async () => {
      const harness = await mountGame();
      await harness.instance.hydrate(null);
      await harness.instance.start();

      queueCollision("furniture", 132.4, 157);
      harness.emitFrame({ steps: 1 });
      await flushAsync();

      expect(textOf(harness.mount, "paper-glider-status")).toBe("Flight over");
      expect(textOf(harness.mount, "paper-glider-result")).toBe("Hit furniture at 132 — score 157");
      const types = harness.events.map((event) => event.type);
      expect(types).toContain("collision");
      expect(types).toContain("run.end");
      expect(harness.recordScore).toHaveBeenCalledWith({
        mode: "flight",
        challengeId: null,
        value: 157,
      });
    });

    it("maps the pure core's collision reason to a sanitizer-approved outcome, never the raw string", async () => {
      const harness = await mountGame();
      await harness.instance.hydrate(null);
      await harness.instance.start();

      queueCollision("wall", 50, 50);
      harness.emitFrame({ steps: 1 });

      const collision = harness.events.find((event) => event.type === "collision");
      const runEnd = harness.events.find((event) => event.type === "run.end");
      expect(collision?.metadata?.outcome).toBe("collision");
      expect(runEnd?.metadata?.outcome).toBe("collision");
      for (const event of harness.events) {
        expect(JSON.stringify(event.metadata ?? {})).not.toMatch(/"wall"|"furniture"|"bounds"/);
      }
    });

    it("emits nothing the runtime sanitizer would reject, across a full run lifecycle", async () => {
      const harness = await mountGame();
      await harness.instance.hydrate(null);
      await harness.instance.start();
      queueRing();
      harness.emitFrame({ steps: 1 });
      queueCollision("bounds", 88, 113);
      harness.emitFrame({ steps: 1 });
      await flushAsync();

      expect(harness.events.length).toBeGreaterThanOrEqual(5); // ready, start, ring, collision, end
      for (const event of harness.events) {
        expect(sanitizeVectorRuntimeEvent(event), `${event.type} was rejected by the sanitizer`).not.toBeNull();
      }
    });

    it("keeps the flight inert after a collision — extra frames change nothing", async () => {
      const harness = await mountGame();
      await harness.instance.hydrate(null);
      await harness.instance.start();
      queueCollision("wall", 75, 75);
      harness.emitFrame({ steps: 1 });
      const distance = textOf(harness.mount, "paper-glider-distance");
      const eventCount = harness.events.length;

      harness.emitFrame({ steps: 600 });

      expect(textOf(harness.mount, "paper-glider-distance")).toBe(distance);
      expect(harness.events.length).toBe(eventCount);
    });

    it("does not resume a crashed run", async () => {
      const harness = await mountGame();
      await harness.instance.hydrate(null);
      await harness.instance.start();
      queueCollision("wall", 75, 75);
      harness.emitFrame({ steps: 1 });

      await harness.instance.resume();
      harness.emitFrame({ steps: 60 });

      expect(textOf(harness.mount, "paper-glider-status")).toBe("Flight over");
      expect(textOf(harness.mount, "paper-glider-distance")).toBe("75");
    });
  });

  describe("fly again", () => {
    it("stays hidden during a run and appears once the flight ends", async () => {
      const harness = await mountGame();
      await harness.instance.hydrate(null);
      await harness.instance.start();
      const button = harness.mount.querySelector(
        '[data-testid="paper-glider-fly-again"]',
      ) as HTMLButtonElement;
      expect(button.hidden).toBe(true);

      queueCollision("bounds", 40, 40);
      harness.emitFrame({ steps: 1 });

      expect(button.hidden).toBe(false);
    });

    it("starts a fresh flight on a fresh seed, entirely in-band", async () => {
      const harness = await mountGame();
      await harness.instance.hydrate(null);
      await harness.instance.start();
      queueCollision("bounds", 40, 40);
      harness.emitFrame({ steps: 1 });
      const seedsUsedBefore = seedCounter;

      const button = harness.mount.querySelector(
        '[data-testid="paper-glider-fly-again"]',
      ) as HTMLButtonElement;
      button.dispatchEvent(new Event("click", { bubbles: true }));

      expect(textOf(harness.mount, "paper-glider-status")).toBe("Flying");
      expect(textOf(harness.mount, "paper-glider-distance")).toBe("0");
      expect(textOf(harness.mount, "paper-glider-result")).toBe("—");
      expect(button.hidden).toBe(true);
      // deterministicSeed is false: a restart must roll a NEW seed, never
      // re-fly the last one.
      expect(seedCounter).toBeGreaterThan(seedsUsedBefore);
    });
  });

  describe("persistence", () => {
    it("round-trips bests through serialize and hydrate, at the manifest's schema version", async () => {
      const manifest = requireVectorGame("paper-glider");
      const harness = await mountGame();
      const data = { version: 1, bestScore: 240, bestDistance: 190, bestRingsCollected: 2 };
      await harness.instance.hydrate({ schemaVersion: PAPER_GLIDER_SAVE_SCHEMA_VERSION, data });

      const save = await harness.instance.serialize();

      // The save schema version is a three-way contract: the progress module,
      // the serialized envelope, and the registry manifest must agree or the
      // host's migrators dispatch on a lie.
      expect(save.schemaVersion).toBe(PAPER_GLIDER_SAVE_SCHEMA_VERSION);
      expect(save.schemaVersion).toBe(manifest.saveSchemaVersion);
      expect(save.data).toEqual(data);
      // No seed in the envelope: deterministicSeed is false and no run resume
      // exists, so a persisted seed would promise a replay the game lacks.
      expect(save.seed).toBeUndefined();
    });

    it("starts fresh bests rather than half-restoring a corrupt save", async () => {
      const harness = await mountGame();
      await harness.instance.hydrate({
        schemaVersion: PAPER_GLIDER_SAVE_SCHEMA_VERSION,
        data: { version: 99, bestScore: -5 },
      });

      expect((await harness.instance.serialize()).data).toEqual(initialSaveData());
    });

    it("survives a null save", async () => {
      const harness = await mountGame();

      await expect((async () => harness.instance.hydrate(null))()).resolves.not.toThrow();
      expect((await harness.instance.serialize()).data).toEqual(initialSaveData());
    });

    it("folds a finished flight into the persisted bests via the Math.max merge", async () => {
      const harness = await mountGame();
      await harness.instance.hydrate({
        schemaVersion: PAPER_GLIDER_SAVE_SCHEMA_VERSION,
        data: { version: 1, bestScore: 500, bestDistance: 10, bestRingsCollected: 0 },
      });
      await harness.instance.start();

      queueCollision("wall", 120, 120);
      harness.emitFrame({ steps: 1 });

      const saved = (await harness.instance.serialize()).data as ReturnType<typeof initialSaveData>;
      // Per-field maximum: the shorter score must not clobber the stored 500,
      // while the longer distance must replace the stored 10.
      expect(saved.bestScore).toBe(500);
      expect(saved.bestDistance).toBe(120);
    });
  });

  describe("score reporting", () => {
    it("says so plainly when the host cannot record a score", async () => {
      const harness = await mountGame({ getBestScore: undefined, recordScore: undefined });

      // Absent is not the same as "no score yet", and the UI must not imply it is.
      expect(textOf(harness.mount, "paper-glider-best")).toBe("Not available here");
    });

    it("shows the authoritative best after a crash, not just this run's own score", async () => {
      const getBestScore = vi.fn(async () => 999);
      const harness = await mountGame({ getBestScore });
      await harness.instance.hydrate(null);
      await harness.instance.start();

      queueCollision("wall", 100, 100);
      harness.emitFrame({ steps: 1 });
      await flushAsync();

      expect(textOf(harness.mount, "paper-glider-best")).toBe("999");
    });

    it("falls back to this run's own score when there is no prior best, not a false 'None yet'", async () => {
      const getBestScore = vi.fn(async () => null);
      const harness = await mountGame({ getBestScore });
      await harness.instance.hydrate(null);
      await harness.instance.start();

      queueCollision("wall", 100, 100);
      harness.emitFrame({ steps: 1 });
      await flushAsync();

      expect(textOf(harness.mount, "paper-glider-best")).toBe("100");
    });
  });

  describe("dispose", () => {
    it("releases the scheduler, every listener, every GPU resource, and the GL context", async () => {
      const harness = await mountGame();
      const mount = harness.mount;

      await harness.instance.dispose();

      expect(harness.unsubscribe).toHaveBeenCalledTimes(1);
      expect(rendererDispose).toHaveBeenCalledTimes(1);
      // renderer.dispose() releases programs but not the context itself;
      // without the forced loss, retry remounts exhaust the browser's context
      // budget far from the cause.
      expect(loseContext).toHaveBeenCalledTimes(1);
      expect(mount.childElementCount).toBe(0);
      expect(resizeObservers.at(-1)?.disconnect).toHaveBeenCalled();

      // EVERY geometry and material this shell created must be disposed —
      // including the shared unit box, edges, torus, and each material.
      expect(createdGeometries.length).toBeGreaterThan(0);
      expect(createdMaterials.length).toBeGreaterThan(0);
      for (const geometry of createdGeometries) {
        expect(geometry.dispose).toHaveBeenCalled();
      }
      for (const material of createdMaterials) {
        expect(material.dispose).toHaveBeenCalled();
      }

      // Listeners must be gone, not merely orphaned.
      const event = new KeyboardEvent("keydown", { code: "ArrowLeft", cancelable: true, bubbles: true });
      mount.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    });

    it("is idempotent", async () => {
      const harness = await mountGame();

      await harness.instance.dispose();
      await harness.instance.dispose();

      expect(rendererDispose).toHaveBeenCalledTimes(1);
      expect(loseContext).toHaveBeenCalledTimes(1);
    });

    it("absorbs a late in-flight scheduler frame after teardown without stepping, emitting, or throwing", async () => {
      const harness = await mountGame();
      await harness.instance.hydrate(null);
      await harness.instance.start();
      harness.emitFrame({ steps: 3 });
      await harness.instance.dispose();

      // Deliver the frame to the REAL subscribed callback, NOT through
      // emitFrame: the mock scheduler's unsubscribe nulls its own listener
      // reference, so an emitFrame here would be a no-op inside the mock and
      // never reach game code at all (the earlier form of this test proved
      // nothing for exactly that reason). A captured reference models the
      // frame that was already in flight when dispose() unsubscribed — the
      // one delivery unsubscribing cannot recall.
      const lateFrame = harness.rawListeners.at(-1);
      expect(lateFrame).toBeDefined();
      const stepCalls = vi.mocked(stepPaperGliderSimulation).mock.calls.length;
      const eventCount = harness.events.length;
      const renders = renderSpy.mock.calls.length;

      expect(() =>
        lateFrame?.({ nowMs: 0, steps: 5, stepMs: 1000 / 60, elapsedMs: 1000 / 60, droppedMs: 0, alpha: 1 }),
      ).not.toThrow();

      // Inert, not merely survivable: no simulation steps, no events, no
      // renders into the disposed renderer.
      expect(vi.mocked(stepPaperGliderSimulation).mock.calls.length).toBe(stepCalls);
      expect(harness.events.length).toBe(eventCount);
      expect(renderSpy.mock.calls.length).toBe(renders);
    });

    it("does not create a renderer (or leak a context) when dispose() races initialize()", async () => {
      const { createPaperGliderGame } = await import("@/lib/vector/games/paper-glider/game");
      const built = buildContext();
      const instance = createPaperGliderGame(built.context);

      const pending = instance.initialize();
      instance.dispose();
      await pending;

      expect(createdRenderers).toBe(0);
      expect(built.context.mount.childElementCount).toBe(0);
    });
  });

  describe("display context loss", () => {
    it("stops stepping and rendering when the context is lost", async () => {
      const harness = await mountGame();
      await harness.instance.hydrate(null);
      await harness.instance.start();
      harness.emitFrame({ steps: 10 });
      const distance = textOf(harness.mount, "paper-glider-distance");
      const renders = renderSpy.mock.calls.length;

      await harness.instance.handleContextLoss?.();
      harness.emitFrame({ steps: 600 });

      expect(textOf(harness.mount, "paper-glider-status")).toBe("Display context lost");
      expect(textOf(harness.mount, "paper-glider-distance")).toBe(distance);
      expect(renderSpy.mock.calls.length).toBe(renders);
    });

    it("forces one render on restore rather than waiting for the next state change", async () => {
      const harness = await mountGame();
      await harness.instance.handleContextLoss?.();
      const renders = renderSpy.mock.calls.length;

      await harness.instance.handleContextRestore?.();

      expect(renderSpy.mock.calls.length).toBeGreaterThan(renders);
      expect(textOf(harness.mount, "paper-glider-status")).toBe("Ready");
    });
  });

  describe("bounded scene graph", () => {
    it("prunes rooms behind the flight so an endless, self-extending run cannot accrete scene geometry", async () => {
      // The room window (ROOM_WINDOW in game.ts: 1 behind + 3 ahead + the
      // current room) is what keeps an endless flight from exhausting the
      // WebGL geometry budget the file header cites. Fly far enough to cross
      // many room boundaries AND force level extensions, checking the bound
      // after every frame — a pruning regression accretes one group per room
      // and fails this within a few rooms.
      const actual = await vi.importActual<typeof import("@/lib/vector/games/paper-glider/simulation")>(
        "@/lib/vector/games/paper-glider/simulation",
      );
      // Autopilot at the fixed-step level: the shell's own input path cannot
      // re-aim per step from a test, so substitute the completability sweep's
      // exit-centre target while keeping the REAL step function authoritative.
      vi.mocked(stepPaperGliderSimulation).mockImplementation((simulation) => {
        const room = roomAtDistance(simulation.level, simulation.body.z);
        return actual.stepPaperGliderSimulation(simulation, { x: room.exit.x, y: room.exit.y });
      });

      const harness = await mountGame();
      await harness.instance.hydrate(null);
      await harness.instance.start();
      const scene = createdScenes.at(-1);
      expect(scene).toBeDefined();

      const MAX_BUILT_ROOMS = 1 + 3 + 1; // ROOM_WINDOW.BEHIND + ROOM_WINDOW.AHEAD + the current room
      for (let frame = 0; frame < 30; frame += 1) {
        harness.emitFrame({ steps: 30 });
        // Scene children = the glider mesh + one group per built room.
        expect(
          (scene?.children.length ?? 0) - 1,
          `after frame ${frame}: built room groups exceed the ${MAX_BUILT_ROOMS}-room window — pruning broke`,
        ).toBeLessThanOrEqual(MAX_BUILT_ROOMS);
      }

      // The bound only means something if the flight really outran the window
      // and the initially-generated level: 900 steps crosses ~20 rooms
      // (z > 800), far past both the 5-room window and INITIAL_ROOM_COUNT *
      // ROOM_DEPTH = 480 — so extension-appended rooms were built and pruned
      // too, and the run must still be alive for the traversal to be real.
      const distance = Number(textOf(harness.mount, "paper-glider-distance"));
      expect(distance).toBeGreaterThan(480);
      expect(textOf(harness.mount, "paper-glider-status")).toBe("Flying");

      vi.mocked(stepPaperGliderSimulation).mockRestore();
    });
  });

  describe("reduced motion", () => {
    it("removes cosmetic banking and snaps the camera; the simulation is untouched", async () => {
      const reduced = await mountGame({
        settings: { ...DEFAULT_VECTOR_RUNTIME_SETTINGS, resolvedMotion: "reduced" },
      });
      await reduced.instance.hydrate(null);
      await reduced.instance.start();
      reduced.mount.dispatchEvent(new KeyboardEvent("keydown", { code: "ArrowRight", bubbles: true }));
      reduced.emitFrame({ steps: 10, alpha: 1 });

      const reducedGlider = glider();
      expect(reducedGlider.position.x).toBeGreaterThan(0); // the flight still steers
      expect(reducedGlider.rotation.z).toBe(0); // …but never banks
      // Camera snaps: laterally exactly on the glider, no residual easing gap.
      expect(camera().position.x).toBe(reducedGlider.position.x);
      const reducedX = reducedGlider.position.x;

      document.body.replaceChildren();
      seedCounter = 0; // the standard flight re-flies the same fixed seed
      const standard = await mountGame({
        settings: { ...DEFAULT_VECTOR_RUNTIME_SETTINGS, resolvedMotion: "standard" },
      });
      await standard.instance.hydrate(null);
      await standard.instance.start();
      standard.mount.dispatchEvent(new KeyboardEvent("keydown", { code: "ArrowRight", bubbles: true }));
      standard.emitFrame({ steps: 10, alpha: 1 });

      const standardGlider = glider();
      // The same inputs steer the same flight — reduced motion changed
      // feedback, never the simulation.
      expect(standardGlider.position.x).toBeCloseTo(reducedX, 10);
      expect(standardGlider.rotation.z).not.toBe(0);
      // The camera eases: it has closed only part of the gap to the glider.
      expect(camera().position.x).toBeGreaterThan(0);
      expect(camera().position.x).toBeLessThan(standardGlider.position.x);
    });
  });

  describe("no fake state", () => {
    it("never claims a rank, leaderboard, achievement, or presence it does not have", async () => {
      const harness = await mountGame();
      await harness.instance.hydrate(null);
      await harness.instance.start();
      queueCollision("wall", 50, 50);
      harness.emitFrame({ steps: 1 });
      await flushAsync();

      const text = harness.mount.textContent ?? "";
      expect(text).not.toMatch(/rank|leaderboard|achievement|worldwide|players online|installed|synced/i);
    });

    it("pins the manifest fields this wave decided", () => {
      const manifest = requireVectorGame("paper-glider");
      // Keyboard steering is real (see the input suite above), so the claim is true…
      expect(manifest.input.keyboard).toBe(true);
      // …achievements are not, so that claim must stay false: none is defined
      // anywhere, and the sanitizer drops string achievementId values outright.
      expect(manifest.score.achievements).toBe(false);
      expect(manifest.save.deterministicSeed).toBe(false);
      expect(manifest.saveSchemaVersion).toBe(PAPER_GLIDER_SAVE_SCHEMA_VERSION);
      // Only what the shell does: no curtains, dust, or loose pages exist yet.
      expect(manifest.reducedMotionBehavior).not.toMatch(/curtain|dust|loose[- ]page/i);
      expect(manifest.status).toBe("planned");
    });
  });
});
