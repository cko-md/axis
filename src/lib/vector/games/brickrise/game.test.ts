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
import {
  BRICKRISE_SAVE_SCHEMA_VERSION,
  toSaveData,
  initialRunState,
  reachCheckpoint,
  toPersistedScore,
} from "@/lib/vector/games/brickrise/progress";
import { generateBrickriseLevel } from "@/lib/vector/games/brickrise/level";
import { stepBrickriseSimulation } from "@/lib/vector/games/brickrise/simulation";

/** Checkpoints in a tower, derived rather than hardcoded so config can move. */
const CHECKPOINT_COUNT = generateBrickriseLevel("count-probe").checkpoints.length;

/**
 * Brickrise's shell is the one part of the game that needs an engine and a
 * canvas, so Phaser is replaced here with a recording double. That is not a
 * shortcut around the real thing: the rules are already covered by
 * simulation/physics/level/progress tests, and what remains to prove about this
 * file is exactly the orchestration a double can observe — that the scheduler
 * (not Phaser) drives simulation, that input reaches the state machine, that
 * every listener and the WebGL context are released on dispose, and that a
 * hostile save cannot half-restore a run.
 */

const loseContext = vi.fn();
const destroy = vi.fn();
const runDestroy = vi.fn();
const loopStop = vi.fn();
const setScroll = vi.fn();
const setBounds = vi.fn();
const graphicsCalls: string[] = [];

let createdGames = 0;
let capturedCanvas: HTMLCanvasElement | null = null;
const phaserVisibilityHandler = () => undefined;

/** jsdom does not implement PointerEvent; this carries the fields we read. */
function pointer(type: string, pointerId: number): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  return event;
}

vi.mock("phaser", () => {
  class FakeGame {
    canvas: HTMLCanvasElement;
    loop = { stop: loopStop };
    destroy = destroy;
    runDestroy = runDestroy;

    constructor(config: Record<string, unknown>) {
      createdGames += 1;
      const doc = (config.parent as HTMLElement).ownerDocument;
      this.canvas = doc.createElement("canvas");
      capturedCanvas = this.canvas;
      // A real WebGL context is unavailable in jsdom; expose just the surface
      // dispose() reaches for.
      this.canvas.getContext = vi.fn(() => ({
        getExtension: () => ({ loseContext }),
      })) as unknown as HTMLCanvasElement["getContext"];
      (config.parent as HTMLElement).appendChild(this.canvas);

      const graphics = {
        clear: () => graphicsCalls.push("clear"),
        fillStyle: () => graphicsCalls.push("fillStyle"),
        fillRect: () => graphicsCalls.push("fillRect"),
      };
      const bootedScene = {
        add: { graphics: () => graphics },
        cameras: { main: { setBounds, setScroll } },
      };
      this.scene = { getScene: () => bootedScene };

      // Emulate Phaser 3.90's VisibilityHandler, which registers a document
      // listener and clobbers window.onblur and never undoes either. Without
      // this the cleanup test would pass vacuously.
      document.addEventListener("visibilitychange", phaserVisibilityHandler, false);
      window.onblur = () => undefined;

      const sceneConfig = config.scene as { create: () => void };
      // Phaser invokes create() during boot; the shell resolves initialize() on it.
      queueMicrotask(() => sceneConfig.create());
    }

    scene: { getScene: () => unknown };

    step = vi.fn();
  }

  return {
    default: {
      Game: FakeGame,
      AUTO: 0,
      Scale: { FIT: 1, CENTER_BOTH: 2 },
    },
  };
});

// The physics/level/checkpoint rules that decide when a summit event fires
// are already exhaustively covered in simulation.test.ts and physics.test.ts
// (including a real-tower reachability search). Scripting a full climb here
// would duplicate that coverage without proving anything new about this
// file. Wrapping the real step function instead lets a specific test queue a
// canned event with mockImplementationOnce, so what gets proven here is
// exactly this file's job: reacting correctly to an event, not producing one.
vi.mock("@/lib/vector/games/brickrise/simulation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/vector/games/brickrise/simulation")>();
  return { ...actual, stepBrickriseSimulation: vi.fn(actual.stepBrickriseSimulation) };
});

type Harness = {
  instance: VectorGameInstance;
  mount: HTMLElement;
  events: VectorRuntimeEvent[];
  emitFrame: (overrides?: Partial<VectorRuntimeFrame>) => void;
  recordScore: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  context: VectorGameCreateContext;
};

async function mountGame(
  overrides: Partial<VectorGameCreateContext> = {},
): Promise<Harness> {
  const { createBrickriseGame } = await import("@/lib/vector/games/brickrise/game");

  const mount = document.createElement("div");
  document.body.appendChild(mount);

  const events: VectorRuntimeEvent[] = [];
  let listener: ((frame: VectorRuntimeFrame) => void) | null = null;
  const unsubscribe = vi.fn(() => {
    listener = null;
  });
  const recordScore = vi.fn();

  const context: VectorGameCreateContext = {
    mount,
    manifest: requireVectorGame("brickrise"),
    settings: DEFAULT_VECTOR_RUNTIME_SETTINGS,
    scheduler: {
      subscribe: (next) => {
        listener = next;
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

  const instance = createBrickriseGame(context);
  await instance.initialize();

  return {
    instance,
    mount,
    events,
    recordScore,
    unsubscribe,
    context,
    emitFrame: (frameOverrides = {}) =>
      listener?.({
        nowMs: 0,
        steps: 1,
        stepMs: 1000 / 60,
        elapsedMs: 1000 / 60,
        droppedMs: 0,
        alpha: 0,
        ...frameOverrides,
      }),
  };
}

function textOf(mount: HTMLElement, testId: string): string {
  return mount.querySelector(`[data-testid="${testId}"]`)?.textContent ?? "";
}

/** Makes the next real step report a summit, without scripting a real climb. */
function queueSummitEvent(elapsedMs: number, deaths: number): void {
  vi.mocked(stepBrickriseSimulation).mockImplementationOnce((simulation) => ({
    simulation: { ...simulation, run: { ...simulation.run, completed: true, elapsedMs } },
    events: [{ type: "summit", elapsedMs, deaths }],
  }));
}

/** Drains the microtask queue so a chained getBestScore().then(...) settles. */
async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  createdGames = 0;
  capturedCanvas = null;
  graphicsCalls.length = 0;
  vi.clearAllMocks();
});

afterEach(() => {
  document.body.replaceChildren();
});

describe("Brickrise shell", () => {
  it("boots Phaser and reports runtime readiness", async () => {
    const harness = await mountGame();

    expect(createdGames).toBe(1);
    expect(harness.events.map((event) => event.type)).toContain("runtime.ready");
    expect(harness.mount.querySelector('[data-testid="brickrise-root"]')).not.toBeNull();
  });

  it("hands the clock to the VECTOR scheduler rather than Phaser's loop", async () => {
    await mountGame();

    // The single-clock invariant: if Phaser's rAF keeps running, simulation
    // becomes wall-clock dependent and the fixed-step guarantee is gone.
    expect(loopStop).toHaveBeenCalledTimes(1);
  });

  it("does not enable Arcade Physics", async () => {
    // stepBody is the only authority on motion. A second physics system would
    // quietly take over the first time a sprite gained a body.
    const { createBrickriseGame } = await import("@/lib/vector/games/brickrise/game");
    expect(createBrickriseGame).toBeTypeOf("function");
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync("src/lib/vector/games/brickrise/game.ts", "utf8"),
    );
    expect(source).not.toMatch(/physics:\s*\{/);
  });

  describe("simulation is driven only by scheduler frames", () => {
    it("does not advance before start()", async () => {
      const harness = await mountGame();

      harness.emitFrame({ steps: 10 });

      expect(textOf(harness.mount, "brickrise-elapsed")).toBe("0s");
    });

    it("advances exactly the number of steps the frame reports", async () => {
      const harness = await mountGame();
      await harness.instance.hydrate(null);
      await harness.instance.start();

      // 60 steps at a 60 Hz fixed timestep is one second, regardless of how
      // much wall-clock time the frame claims to represent.
      harness.emitFrame({ steps: 60, elapsedMs: 999_999 });

      expect(textOf(harness.mount, "brickrise-elapsed")).toBe("1s");
    });

    it("stops advancing while paused", async () => {
      const harness = await mountGame();
      await harness.instance.hydrate(null);
      await harness.instance.start();
      harness.emitFrame({ steps: 60 });
      await harness.instance.pause("visibility");

      harness.emitFrame({ steps: 600 });

      expect(textOf(harness.mount, "brickrise-elapsed")).toBe("1s");
    });
  });

  describe("input", () => {
    it("routes game keys into the input state machine and claims them", async () => {
      const harness = await mountGame();

      // Dispatch on the MOUNT, not on the game's own root. The host focuses the
      // mount, so this is the only target that occurs in production — an
      // earlier version of this test dispatched on the inner root and passed
      // while the game was completely unplayable by keyboard.
      const event = new KeyboardEvent("keydown", { code: "ArrowLeft", cancelable: true, bubbles: true });
      harness.mount.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
      expect(
        harness.mount.querySelector('[data-testid="brickrise-touch-left"]')!.getAttribute("aria-pressed"),
      ).toBe("true");
    });

    it("leaves Escape to the host so pause keeps working", async () => {
      const harness = await mountGame();

      const event = new KeyboardEvent("keydown", { code: "Escape", cancelable: true, bubbles: true });
      harness.mount.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(false);
    });

    it("releases held input when the document is hidden", async () => {
      const harness = await mountGame();
      harness.mount.dispatchEvent(new KeyboardEvent("keydown", { code: "ArrowRight", bubbles: true }));

      vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      document.dispatchEvent(new Event("visibilitychange"));

      expect(
        harness.mount.querySelector('[data-testid="brickrise-touch-right"]')!.getAttribute("aria-pressed"),
      ).toBe("false");
    });

    it("exposes touch controls as real buttons with accessible names", async () => {
      const harness = await mountGame();

      for (const testId of ["brickrise-touch-left", "brickrise-touch-right", "brickrise-touch-jump"]) {
        const button = harness.mount.querySelector(`[data-testid="${testId}"]`)!;
        expect(button.tagName).toBe("BUTTON");
        expect(button.getAttribute("aria-label")).toBeTruthy();
      }
    });
  });

  describe("persistence", () => {
    it("round-trips a run through serialize and hydrate", async () => {
      const harness = await mountGame();
      await harness.instance.hydrate({
        schemaVersion: BRICKRISE_SAVE_SCHEMA_VERSION,
        data: toSaveData(reachCheckpoint({ ...initialRunState("saved-seed"), deaths: 3 }, 1)),
        seed: "saved-seed",
      });

      const save = await harness.instance.serialize();

      expect(save.schemaVersion).toBe(BRICKRISE_SAVE_SCHEMA_VERSION);
      expect(save.seed).toBe("saved-seed");
      expect(textOf(harness.mount, "brickrise-deaths")).toBe("3");
      expect(textOf(harness.mount, "brickrise-checkpoint")).toBe(`2 of ${CHECKPOINT_COUNT}`);
    });

    it("starts a fresh run rather than half-restoring a corrupt save", async () => {
      const harness = await mountGame();

      await harness.instance.hydrate({
        schemaVersion: BRICKRISE_SAVE_SCHEMA_VERSION,
        data: { version: 99, seed: "", deaths: -5 },
      });

      expect(textOf(harness.mount, "brickrise-deaths")).toBe("0");
      expect(textOf(harness.mount, "brickrise-checkpoint")).toBe(`None of ${CHECKPOINT_COUNT}`);
    });

    it("survives a null save", async () => {
      const harness = await mountGame();

      await expect(
        (async () => harness.instance.hydrate(null))(),
      ).resolves.not.toThrow();
      expect(textOf(harness.mount, "brickrise-checkpoint")).toBe(`None of ${CHECKPOINT_COUNT}`);
    });
  });

  describe("score reporting", () => {
    it("says so plainly when the host cannot record a score", async () => {
      const harness = await mountGame({ getBestScore: undefined, recordScore: undefined });

      // Absent is not the same as "no score yet", and the UI must not imply it is.
      expect(textOf(harness.mount, "brickrise-best")).toBe("Not available here");
    });

    it("never claims a rank the platform cannot verify", async () => {
      const harness = await mountGame();
      const text = harness.mount.textContent ?? "";

      expect(text).not.toMatch(/rank|leaderboard|worldwide|players online/i);
    });
  });

  describe("dispose", () => {
    it("releases the scheduler, the listeners, the canvas and the GL context", async () => {
      const harness = await mountGame();
      const mount = harness.mount;

      await harness.instance.dispose();

      expect(harness.unsubscribe).toHaveBeenCalledTimes(1);
      expect(destroy).toHaveBeenCalledWith(true, false);
      // The loop is stopped, so destroy() alone would defer teardown forever.
      expect(runDestroy).toHaveBeenCalledTimes(1);
      expect(loseContext).toHaveBeenCalledTimes(1);
      expect(harness.mount.childElementCount).toBe(0);

      // Listeners must be gone, not merely orphaned.
      const event = new KeyboardEvent("keydown", { code: "ArrowLeft", cancelable: true });
      mount.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    });

    it("is idempotent", async () => {
      const harness = await mountGame();

      await harness.instance.dispose();
      await harness.instance.dispose();

      expect(runDestroy).toHaveBeenCalledTimes(1);
    });

    it("ignores a late scheduler frame delivered after teardown", async () => {
      const harness = await mountGame();
      await harness.instance.hydrate(null);
      await harness.instance.start();
      await harness.instance.dispose();

      expect(() => harness.emitFrame({ steps: 5 })).not.toThrow();
    });
  });

  it("stops drawing when the display context is lost", async () => {
    const harness = await mountGame();
    await harness.instance.hydrate(null);
    await harness.instance.start();

    await harness.instance.handleContextLoss?.();
    const before = textOf(harness.mount, "brickrise-elapsed");
    harness.emitFrame({ steps: 600 });

    expect(textOf(harness.mount, "brickrise-status")).toBe("Display context lost");
    expect(textOf(harness.mount, "brickrise-elapsed")).toBe(before);
  });

  it("keeps a live region for state transitions", async () => {
    const harness = await mountGame();
    await harness.instance.hydrate(null);
    await harness.instance.start();

    const live = harness.mount.querySelector('[role="status"]');
    expect(live?.getAttribute("aria-live")).toBe("polite");
    expect(live?.textContent).toMatch(/Climb started/);
  });

  describe("regressions from the Wave 15.8 adversarial review", () => {
    it("keeps a second pointer from releasing the first pointer's hold", async () => {
      const harness = await mountGame();
      const left = harness.mount.querySelector('[data-testid="brickrise-touch-left"]')! as HTMLElement;

      left.dispatchEvent(pointer("pointerdown", 1));
      expect(left.getAttribute("aria-pressed")).toBe("true");

      // A different finger touching and lifting on the same button must not
      // cancel the hold that pointer 1 still owns.
      left.dispatchEvent(pointer("pointerdown", 2));
      left.dispatchEvent(pointer("pointerup", 2));
      expect(left.getAttribute("aria-pressed")).toBe("true");

      left.dispatchEvent(pointer("pointerup", 1));
      expect(left.getAttribute("aria-pressed")).toBe("false");
    });

    it("keeps the touch buttons in step with the simulation across frames", async () => {
      // The shell re-syncs aria-pressed after every batch of steps, because the
      // simulation clears held input on death (covered in simulation.test.ts).
      // The property asserted here is the other half: ordinary frames must not
      // spuriously drop a hold the player is still making.
      const harness = await mountGame();
      await harness.instance.hydrate(null);
      await harness.instance.start();
      const right = harness.mount.querySelector('[data-testid="brickrise-touch-right"]')!;

      right.dispatchEvent(pointer("pointerdown", 1));
      expect(right.getAttribute("aria-pressed")).toBe("true");

      harness.emitFrame({ steps: 8 });

      expect(right.getAttribute("aria-pressed")).toBe("true");
    });

    it("stops stepping Phaser once the run is neither running nor dirty", async () => {
      const harness = await mountGame();
      await harness.instance.hydrate(null);
      await harness.instance.start();
      await harness.instance.pause("visibility");

      // One settling frame is allowed; after that a paused run must not keep
      // driving a full scene update and render at 60 Hz.
      harness.emitFrame();
      const afterSettle = graphicsCalls.length;
      harness.emitFrame();
      harness.emitFrame();

      expect(graphicsCalls.length).toBe(afterSettle);
    });

    it("releases held input when focus leaves the mount", async () => {
      const harness = await mountGame();
      harness.mount.dispatchEvent(new KeyboardEvent("keydown", { code: "ArrowLeft", bubbles: true }));
      expect(
        harness.mount.querySelector('[data-testid="brickrise-touch-left"]')!.getAttribute("aria-pressed"),
      ).toBe("true");

      // focusout, not blur — blur does not bubble, so a blur listener here
      // would never fire for focus leaving a descendant.
      harness.mount.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));

      expect(
        harness.mount.querySelector('[data-testid="brickrise-touch-left"]')!.getAttribute("aria-pressed"),
      ).toBe("false");
    });

    it("removes the visibility listener Phaser leaves behind, and restores window handlers", async () => {
      const priorBlur = window.onblur;
      const added: string[] = [];
      const removed: string[] = [];
      const realAdd = document.addEventListener.bind(document);
      const realRemove = document.removeEventListener.bind(document);
      vi.spyOn(document, "addEventListener").mockImplementation(((t: string, h: never, o: never) => {
        added.push(t);
        return realAdd(t, h, o);
      }) as typeof document.addEventListener);
      vi.spyOn(document, "removeEventListener").mockImplementation(((t: string, h: never, o: never) => {
        removed.push(t);
        return realRemove(t, h, o);
      }) as typeof document.removeEventListener);

      const harness = await mountGame();
      await harness.instance.dispose();

      // The shell's own visibilitychange listener is covered by the
      // AbortController; what matters here is that dispose leaves no net
      // document listener and puts window.onblur back.
      expect(window.onblur).toBe(priorBlur);
      expect(removed).toContain("visibilitychange");
      vi.restoreAllMocks();
    });
  });

  it("does not construct a second Phaser game when the canvas is present", async () => {
    await mountGame();
    expect(createdGames).toBe(1);
    expect(capturedCanvas).not.toBeNull();
  });

  describe("reset()", () => {
    it("returns the run to a fresh climb and re-establishes the authoritative best", async () => {
      const getBestScore = vi.fn(async () => null);
      const harness = await mountGame({ getBestScore });
      await harness.instance.hydrate({
        schemaVersion: BRICKRISE_SAVE_SCHEMA_VERSION,
        data: toSaveData(reachCheckpoint({ ...initialRunState("saved-seed"), deaths: 3 }, 1)),
        seed: "saved-seed",
      });
      await harness.instance.start();
      harness.emitFrame({ steps: 60 });
      expect(textOf(harness.mount, "brickrise-elapsed")).toBe("1s");
      getBestScore.mockClear();

      await harness.instance.reset();

      expect(textOf(harness.mount, "brickrise-elapsed")).toBe("0s");
      expect(textOf(harness.mount, "brickrise-checkpoint")).toBe(`None of ${CHECKPOINT_COUNT}`);
      expect(textOf(harness.mount, "brickrise-deaths")).toBe("0");
      expect(textOf(harness.mount, "brickrise-status")).toBe("Ready");
      // Regression: a restart must re-read the best rather than leave
      // whatever finishRun last wrote on screen from the previous climb.
      expect(getBestScore).toHaveBeenCalled();
    });

    it("stops the run from advancing until start() is called again", async () => {
      const harness = await mountGame();
      await harness.instance.hydrate(null);
      await harness.instance.start();
      harness.emitFrame({ steps: 60 });

      await harness.instance.reset();
      harness.emitFrame({ steps: 600 });

      expect(textOf(harness.mount, "brickrise-elapsed")).toBe("0s");
    });
  });

  describe("resume()", () => {
    it("resumes stepping after a pause", async () => {
      const harness = await mountGame();
      await harness.instance.hydrate(null);
      await harness.instance.start();
      harness.emitFrame({ steps: 60 });
      await harness.instance.pause("visibility");
      harness.emitFrame({ steps: 600 });
      expect(textOf(harness.mount, "brickrise-elapsed")).toBe("1s");

      await harness.instance.resume();
      harness.emitFrame({ steps: 60 });

      expect(textOf(harness.mount, "brickrise-elapsed")).toBe("2s");
      expect(textOf(harness.mount, "brickrise-status")).toBe("Climbing");
    });

    it("does not resume a completed run", async () => {
      const harness = await mountGame();
      await harness.instance.hydrate({
        schemaVersion: BRICKRISE_SAVE_SCHEMA_VERSION,
        data: toSaveData({ ...initialRunState("done-seed"), completed: true, elapsedMs: 5000 }),
        seed: "done-seed",
      });

      await harness.instance.resume();
      harness.emitFrame({ steps: 60 });

      // A completed run is inert by design (simulation.ts) — resume() must
      // not make it look like it is climbing again.
      expect(textOf(harness.mount, "brickrise-elapsed")).toBe("5s");
    });
  });

  describe("updateSettings()", () => {
    it("marks the frame dirty so a settled, paused run redraws once more", async () => {
      const harness = await mountGame();
      harness.emitFrame(); // consumes the initial needsRedraw from initialize()
      const settled = graphicsCalls.length;
      harness.emitFrame();
      expect(graphicsCalls.length).toBe(settled);

      await harness.instance.updateSettings?.(DEFAULT_VECTOR_RUNTIME_SETTINGS);
      harness.emitFrame();

      expect(graphicsCalls.length).toBeGreaterThan(settled);
    });
  });

  describe("handleContextRestore()", () => {
    it("redraws immediately even while paused, rather than waiting for the next frame", async () => {
      const harness = await mountGame();
      harness.emitFrame(); // consumes the initial needsRedraw
      const before = graphicsCalls.length;

      await harness.instance.handleContextRestore?.();

      expect(graphicsCalls.length).toBeGreaterThan(before);
      expect(textOf(harness.mount, "brickrise-status")).toBe("Ready");
    });
  });

  describe("camera (reduced motion)", () => {
    it("snaps the camera immediately under reduced motion but eases it under standard motion", async () => {
      const reduced = await mountGame({
        settings: { ...DEFAULT_VECTOR_RUNTIME_SETTINGS, resolvedMotion: "reduced" },
      });
      reduced.emitFrame();
      const reducedFirst = setScroll.mock.calls.at(-1)![1] as number;
      // Force a second draw over a body that has not moved. Reduced motion
      // must report the identical scroll position rather than continuing to
      // close a gap that no longer exists.
      await reduced.instance.updateSettings?.({ ...DEFAULT_VECTOR_RUNTIME_SETTINGS, resolvedMotion: "reduced" });
      reduced.emitFrame();
      const reducedSecond = setScroll.mock.calls.at(-1)![1] as number;

      expect(reducedFirst).toBeGreaterThan(0);
      expect(reducedSecond).toBe(reducedFirst);

      setScroll.mockClear();

      const standard = await mountGame({
        settings: { ...DEFAULT_VECTOR_RUNTIME_SETTINGS, resolvedMotion: "standard" },
      });
      standard.emitFrame();
      const standardFirst = setScroll.mock.calls.at(-1)![1] as number;
      await standard.instance.updateSettings?.({ ...DEFAULT_VECTOR_RUNTIME_SETTINGS, resolvedMotion: "standard" });
      standard.emitFrame();
      const standardSecond = setScroll.mock.calls.at(-1)![1] as number;

      // Standard motion eases: the same starting position only closes part
      // of the gap to the same target on each draw, so it undershoots the
      // full snap and keeps moving on the next draw instead of sitting still.
      expect(standardFirst).toBeGreaterThan(0);
      expect(standardFirst).toBeLessThan(reducedFirst);
      expect(standardSecond).toBeGreaterThan(standardFirst);
      expect(standardSecond).toBeLessThan(reducedFirst);
    });
  });

  describe("summit / finishRun", () => {
    it("shows the authoritative best after a summit, not just this run's own time", async () => {
      // This run (45s) is slower than the stored best (30s). The persisted
      // score merge is Math.max over an inverted duration, so a slower run
      // never touches the server-side best — the HUD must not claim it did.
      const storedBestElapsedMs = 30_000;
      const getBestScore = vi.fn(async () => toPersistedScore(storedBestElapsedMs));
      const harness = await mountGame({ getBestScore });
      await harness.instance.hydrate(null);
      await harness.instance.start();

      queueSummitEvent(45_000, 2);
      harness.emitFrame({ steps: 1 });
      await flushAsync();

      expect(harness.recordScore).toHaveBeenCalledWith({
        mode: "climb",
        challengeId: null,
        value: toPersistedScore(45_000),
      });
      expect(textOf(harness.mount, "brickrise-best")).toBe("30s");
      expect(textOf(harness.mount, "brickrise-status")).toBe("Summit reached");
    });

    it("falls back to this run's own time when there is no prior best, not a false 'None yet'", async () => {
      const getBestScore = vi.fn(async () => null);
      const harness = await mountGame({ getBestScore });
      await harness.instance.hydrate(null);
      await harness.instance.start();

      queueSummitEvent(12_000, 0);
      harness.emitFrame({ steps: 1 });
      await flushAsync();

      expect(textOf(harness.mount, "brickrise-best")).toBe("12s");
    });

    it("says so plainly when the host cannot report a best after a summit", async () => {
      const harness = await mountGame({ getBestScore: undefined });
      await harness.instance.hydrate(null);
      await harness.instance.start();

      queueSummitEvent(12_000, 0);
      harness.emitFrame({ steps: 1 });
      await flushAsync();

      expect(textOf(harness.mount, "brickrise-best")).toBe("Not available here");
    });

    it("announces the summit and emits a run.complete event", async () => {
      const harness = await mountGame();
      await harness.instance.hydrate(null);
      await harness.instance.start();

      queueSummitEvent(65_000, 3);
      harness.emitFrame({ steps: 1 });
      await flushAsync();

      expect(harness.events.map((event) => event.type)).toContain("run.complete");
      const live = harness.mount.querySelector('[role="status"]');
      expect(live?.textContent).toMatch(/Summit reached in 1m 05s with 3 falls/);
    });
  });

  describe("climb again (no self-contained path back to a new climb after the summit)", () => {
    it("stays hidden during a run and appears once the summit is reached", async () => {
      const harness = await mountGame();
      await harness.instance.hydrate(null);
      await harness.instance.start();
      const button = harness.mount.querySelector(
        '[data-testid="brickrise-climb-again"]',
      ) as HTMLButtonElement;
      expect(button.hidden).toBe(true);

      queueSummitEvent(20_000, 0);
      harness.emitFrame({ steps: 1 });

      expect(button.hidden).toBe(false);
    });

    it("starts a fresh climb entirely in-band, without the host's pause/restart flow", async () => {
      const harness = await mountGame();
      await harness.instance.hydrate(null);
      await harness.instance.start();
      queueSummitEvent(20_000, 0);
      harness.emitFrame({ steps: 1 });
      expect(textOf(harness.mount, "brickrise-status")).toBe("Summit reached");

      const button = harness.mount.querySelector(
        '[data-testid="brickrise-climb-again"]',
      ) as HTMLButtonElement;
      button.dispatchEvent(new Event("click", { bubbles: true }));

      expect(textOf(harness.mount, "brickrise-status")).toBe("Climbing");
      expect(textOf(harness.mount, "brickrise-elapsed")).toBe("0s");
      expect(button.hidden).toBe(true);
    });
  });

  describe("cross-source input regressions", () => {
    it("keeps a touch-button release from cancelling a direction held on the keyboard", async () => {
      const harness = await mountGame();
      harness.mount.dispatchEvent(new KeyboardEvent("keydown", { code: "ArrowLeft", bubbles: true }));
      const left = harness.mount.querySelector('[data-testid="brickrise-touch-left"]')!;
      expect(left.getAttribute("aria-pressed")).toBe("true");

      // A stray click on the on-screen button while ArrowLeft is still
      // physically held must not cancel the keyboard hold.
      left.dispatchEvent(pointer("pointerdown", 1));
      left.dispatchEvent(pointer("pointerup", 1));
      expect(left.getAttribute("aria-pressed")).toBe("true");

      harness.mount.dispatchEvent(new KeyboardEvent("keyup", { code: "ArrowLeft", bubbles: true }));
      expect(left.getAttribute("aria-pressed")).toBe("false");
    });

    it("keeps a keyboard release from cancelling a direction held on a touch button", async () => {
      const harness = await mountGame();
      const right = harness.mount.querySelector('[data-testid="brickrise-touch-right"]')!;
      right.dispatchEvent(pointer("pointerdown", 1));
      expect(right.getAttribute("aria-pressed")).toBe("true");

      harness.mount.dispatchEvent(new KeyboardEvent("keydown", { code: "ArrowRight", bubbles: true }));
      harness.mount.dispatchEvent(new KeyboardEvent("keyup", { code: "ArrowRight", bubbles: true }));
      expect(right.getAttribute("aria-pressed")).toBe("true");

      right.dispatchEvent(pointer("pointerup", 1));
      expect(right.getAttribute("aria-pressed")).toBe("false");
    });

    it("keeps a touch jump-button release from cancelling a jump held on the keyboard", async () => {
      const harness = await mountGame();
      harness.mount.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", bubbles: true }));
      const jump = harness.mount.querySelector('[data-testid="brickrise-touch-jump"]')!;
      expect(jump.getAttribute("aria-pressed")).toBe("true");

      jump.dispatchEvent(pointer("pointerdown", 1));
      jump.dispatchEvent(pointer("pointerup", 1));
      expect(jump.getAttribute("aria-pressed")).toBe("true");

      harness.mount.dispatchEvent(new KeyboardEvent("keyup", { code: "Space", bubbles: true }));
      expect(jump.getAttribute("aria-pressed")).toBe("false");
    });
  });
});
