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
import { TIME_TO_FLY_ARENA, TIME_TO_FLY_LEVEL_COUNT } from "@/lib/vector/games/time-to-fly/constants";
import {
  TIME_TO_FLY_SAVE_SCHEMA_VERSION,
  initialRunState,
  recordLaunch,
  solveLevel,
  toSaveData,
} from "@/lib/vector/games/time-to-fly/progress";

/**
 * Time to Fly's shell is the one part of the game that needs an engine and a
 * canvas, so Phaser is replaced here with a recording double. That is not a
 * shortcut around the real thing: the rules are already covered by
 * flight/level/verify/progress/inputState/simulation tests, and what remains
 * to prove about this file is exactly the orchestration a double can observe —
 * that the scheduler (not Phaser) drives simulation, that a launch is an edge
 * consumed by a fixed step rather than by an event handler, that input reaches
 * the state machine through the host's mount, that every listener and the
 * WebGL context are released on dispose, and that a hostile save cannot
 * half-restore a run.
 */

const loseContext = vi.fn();
const destroy = vi.fn();
const runDestroy = vi.fn();
const loopStop = vi.fn();
const setZoom = vi.fn();
const centerOn = vi.fn();
const graphicsCalls: string[] = [];

let createdGames = 0;
let capturedCanvas: HTMLCanvasElement | null = null;
const phaserVisibilityHandler = () => undefined;

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
        fillCircle: () => graphicsCalls.push("fillCircle"),
        lineStyle: () => graphicsCalls.push("lineStyle"),
        strokeCircle: () => graphicsCalls.push("strokeCircle"),
      };
      const bootedScene = {
        add: { graphics: () => graphics },
        cameras: { main: { setZoom, centerOn } },
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
  const { createTimeToFlyGame } = await import("@/lib/vector/games/time-to-fly/game");

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
    manifest: requireVectorGame("time-to-fly"),
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

  const instance = createTimeToFlyGame(context);
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

function slotOf(mount: HTMLElement, planetIndex: number): number {
  const match = textOf(mount, `time-to-fly-planet-${planetIndex}`).match(/slot (\d+)/);
  if (!match) throw new Error("planet listing shows no slot");
  return Number(match[1]);
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

describe("Time to Fly shell", () => {
  it("boots Phaser and reports runtime readiness", async () => {
    const harness = await mountGame();

    expect(createdGames).toBe(1);
    expect(harness.events.map((event) => event.type)).toContain("runtime.ready");
    expect(harness.mount.querySelector('[data-testid="time-to-fly-root"]')).not.toBeNull();
  });

  it("hands the clock to the VECTOR scheduler rather than Phaser's loop", async () => {
    await mountGame();

    // The single-clock invariant: if Phaser's rAF keeps running, simulation
    // becomes wall-clock dependent and the fixed-step guarantee is gone.
    expect(loopStop).toHaveBeenCalledTimes(1);
  });

  it("does not enable Arcade Physics", async () => {
    // stepCraft is the only authority on motion. A second physics system would
    // quietly take over the first time a sprite gained a body.
    const { createTimeToFlyGame } = await import("@/lib/vector/games/time-to-fly/game");
    expect(createTimeToFlyGame).toBeTypeOf("function");
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync("src/lib/vector/games/time-to-fly/game.ts", "utf8"),
    );
    expect(source).not.toMatch(/physics:\s*\{/);
  });

  describe("simulation is driven only by scheduler frames", () => {
    it("does not advance before start()", async () => {
      const harness = await mountGame();

      harness.emitFrame({ steps: 10 });

      expect(textOf(harness.mount, "time-to-fly-elapsed")).toBe("0s");
    });

    it("advances exactly the number of steps the frame reports", async () => {
      const harness = await mountGame();
      await harness.instance.hydrate(null);
      await harness.instance.start();

      // 60 steps at a 60 Hz fixed timestep is one second, regardless of how
      // much wall-clock time the frame claims to represent.
      harness.emitFrame({ steps: 60, elapsedMs: 999_999 });

      expect(textOf(harness.mount, "time-to-fly-elapsed")).toBe("1s");
    });

    it("stops advancing while paused", async () => {
      const harness = await mountGame();
      await harness.instance.hydrate(null);
      await harness.instance.start();
      harness.emitFrame({ steps: 60 });
      await harness.instance.pause("visibility");

      harness.emitFrame({ steps: 600 });

      expect(textOf(harness.mount, "time-to-fly-elapsed")).toBe("1s");
    });

    it("treats a launch as an edge consumed by a fixed step, never by the event handler", async () => {
      const harness = await mountGame();
      await harness.instance.hydrate(null);
      await harness.instance.start();

      harness.mount.dispatchEvent(
        new KeyboardEvent("keydown", { code: "Space", cancelable: true, bubbles: true }),
      );
      // The keypress only arms the edge. If this were already "1", input
      // would be advancing the simulation and the scheduler would no longer
      // be the single clock.
      expect(textOf(harness.mount, "time-to-fly-launches")).toBe("0");

      harness.emitFrame({ steps: 1 });

      expect(textOf(harness.mount, "time-to-fly-launches")).toBe("1");
      expect(textOf(harness.mount, "time-to-fly-status")).toBe("In flight");
    });
  });

  describe("input", () => {
    it("routes game keys into the input state machine and claims them", async () => {
      const harness = await mountGame();
      const before = slotOf(harness.mount, 0);

      // Dispatch on the MOUNT, not on the game's own root. The host focuses
      // the mount, so this is the only target that occurs in production.
      const event = new KeyboardEvent("keydown", { code: "ArrowRight", cancelable: true, bubbles: true });
      harness.mount.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
      expect(slotOf(harness.mount, 0)).toBe((before + 1) % 12);
    });

    it("leaves Escape to the host so pause keeps working", async () => {
      const harness = await mountGame();

      const event = new KeyboardEvent("keydown", { code: "Escape", cancelable: true, bubbles: true });
      harness.mount.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(false);
    });

    it("launches from the touch button as well as the keyboard", async () => {
      const harness = await mountGame();
      await harness.instance.hydrate(null);
      await harness.instance.start();

      (harness.mount.querySelector('[data-testid="time-to-fly-touch-launch"]') as HTMLElement).click();
      harness.emitFrame({ steps: 1 });

      expect(textOf(harness.mount, "time-to-fly-launches")).toBe("1");
    });

    it("rotates the selected planet from the touch buttons", async () => {
      const harness = await mountGame();
      const before = slotOf(harness.mount, 0);

      (harness.mount.querySelector('[data-testid="time-to-fly-touch-rotate-right"]') as HTMLElement).click();

      expect(slotOf(harness.mount, 0)).toBe((before + 1) % 12);
    });

    it("disarms a pending launch when focus leaves the mount", async () => {
      const harness = await mountGame();
      await harness.instance.hydrate(null);
      await harness.instance.start();
      harness.mount.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", bubbles: true }));

      // focusout, not blur — blur does not bubble, so a blur listener here
      // would never fire for focus leaving a descendant.
      harness.mount.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      harness.emitFrame({ steps: 1 });

      // The launch the player armed and then walked away from must not fire.
      expect(textOf(harness.mount, "time-to-fly-launches")).toBe("0");
    });

    it("disarms a pending launch when the document is hidden", async () => {
      const harness = await mountGame();
      await harness.instance.hydrate(null);
      await harness.instance.start();
      harness.mount.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", bubbles: true }));

      vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
      harness.emitFrame({ steps: 1 });

      expect(textOf(harness.mount, "time-to-fly-launches")).toBe("0");
    });

    it("exposes touch controls as real buttons with accessible names", async () => {
      const harness = await mountGame();

      for (const testId of [
        "time-to-fly-touch-prev",
        "time-to-fly-touch-next",
        "time-to-fly-touch-rotate-left",
        "time-to-fly-touch-rotate-right",
        "time-to-fly-touch-launch",
      ]) {
        const button = harness.mount.querySelector(`[data-testid="${testId}"]`)!;
        expect(button.tagName).toBe("BUTTON");
        expect(button.getAttribute("aria-label")).toBeTruthy();
      }
    });
  });

  describe("levels", () => {
    it("renders all five levels as real buttons and switches on selection", async () => {
      const harness = await mountGame();
      await harness.instance.hydrate(null);
      await harness.instance.start();

      for (let n = 1; n <= TIME_TO_FLY_LEVEL_COUNT; n += 1) {
        const button = harness.mount.querySelector(`[data-testid="time-to-fly-select-level-${n}"]`)!;
        expect(button.tagName).toBe("BUTTON");
      }
      expect(textOf(harness.mount, "time-to-fly-level")).toBe(`1 of ${TIME_TO_FLY_LEVEL_COUNT}`);

      (harness.mount.querySelector('[data-testid="time-to-fly-select-level-2"]') as HTMLElement).click();

      expect(textOf(harness.mount, "time-to-fly-level")).toBe(`2 of ${TIME_TO_FLY_LEVEL_COUNT}`);
      expect(harness.events).toContainEqual(
        expect.objectContaining({ type: "level.start", metadata: { level: 2 } }),
      );
    });

    it("mirrors planet properties as DOM text", async () => {
      const harness = await mountGame();

      // Level 1 is a single large planet by the binding composition.
      expect(textOf(harness.mount, "time-to-fly-planet-0")).toMatch(/Planet 1 of 1 — large, slot \d+/);
    });
  });

  describe("persistence", () => {
    it("round-trips a run through serialize and hydrate", async () => {
      const harness = await mountGame();
      const saved = recordLaunch(recordLaunch(recordLaunch(solveLevel(initialRunState("saved-seed"), 0))));
      await harness.instance.hydrate({
        schemaVersion: TIME_TO_FLY_SAVE_SCHEMA_VERSION,
        data: toSaveData(saved),
        seed: "saved-seed",
      });

      const save = await harness.instance.serialize();

      expect(save.schemaVersion).toBe(TIME_TO_FLY_SAVE_SCHEMA_VERSION);
      // The manifest's saveSchemaVersion is what the runtime validates saves
      // against; drifting from it silently deletes every player's progress.
      expect(save.schemaVersion).toBe(requireVectorGame("time-to-fly").saveSchemaVersion);
      expect(save.seed).toBe("saved-seed");
      expect(textOf(harness.mount, "time-to-fly-launches")).toBe("3");
      expect(textOf(harness.mount, "time-to-fly-solved")).toBe(`1 of ${TIME_TO_FLY_LEVEL_COUNT}`);
    });

    it("starts a fresh run rather than half-restoring a corrupt save", async () => {
      const harness = await mountGame();

      await harness.instance.hydrate({
        schemaVersion: TIME_TO_FLY_SAVE_SCHEMA_VERSION,
        data: { version: 99, runSeed: "", launches: -5 },
      });

      expect(textOf(harness.mount, "time-to-fly-launches")).toBe("0");
      expect(textOf(harness.mount, "time-to-fly-solved")).toBe(`0 of ${TIME_TO_FLY_LEVEL_COUNT}`);
    });

    it("survives a null save", async () => {
      const harness = await mountGame();

      await expect(
        (async () => harness.instance.hydrate(null))(),
      ).resolves.not.toThrow();
      expect(textOf(harness.mount, "time-to-fly-level")).toBe(`1 of ${TIME_TO_FLY_LEVEL_COUNT}`);
    });
  });

  describe("score reporting", () => {
    it("says so plainly when the host cannot record a score", async () => {
      const harness = await mountGame({ getBestScore: undefined, recordScore: undefined });

      // Absent is not the same as "no score yet", and the UI must not imply it is.
      expect(textOf(harness.mount, "time-to-fly-best")).toBe("Not available here");
    });

    it("never claims a rank the platform cannot verify", async () => {
      const harness = await mountGame();
      const text = harness.mount.textContent ?? "";

      expect(text).not.toMatch(/rank|leaderboard|worldwide|players online|installs|synced/i);
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
      const event = new KeyboardEvent("keydown", { code: "ArrowRight", cancelable: true });
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

  it("stops drawing when the display context is lost", async () => {
    const harness = await mountGame();
    await harness.instance.hydrate(null);
    await harness.instance.start();

    await harness.instance.handleContextLoss?.();
    const before = textOf(harness.mount, "time-to-fly-elapsed");
    harness.emitFrame({ steps: 600 });

    expect(textOf(harness.mount, "time-to-fly-status")).toBe("Display context lost");
    expect(textOf(harness.mount, "time-to-fly-elapsed")).toBe(before);
  });

  it("stops stepping Phaser once the board is neither in flight nor dirty", async () => {
    const harness = await mountGame();
    await harness.instance.hydrate(null);
    await harness.instance.start();

    // One settling frame is allowed; after that a static aiming board must
    // not keep driving a full scene update and render at 60 Hz.
    harness.emitFrame();
    const afterSettle = graphicsCalls.length;
    harness.emitFrame();
    harness.emitFrame();

    expect(graphicsCalls.length).toBe(afterSettle);
  });

  it("keeps a live region for state transitions", async () => {
    const harness = await mountGame();
    await harness.instance.hydrate(null);
    await harness.instance.start();

    const live = harness.mount.querySelector('[role="status"]');
    expect(live?.getAttribute("aria-live")).toBe("polite");
    expect(live?.textContent).toMatch(/Level 1 of 5/);
  });

  it("does not construct a second Phaser game when the canvas is present", async () => {
    await mountGame();
    expect(createdGames).toBe(1);
    expect(capturedCanvas).not.toBeNull();
  });

  describe("pointer-to-world mapping", () => {
    // The continuous drag itself runs against a real canvas rect the jsdom
    // environment cannot supply, so the pure mapping it depends on is proven
    // directly instead.
    it("maps the canvas centre to the arena centre", async () => {
      const { mapClientPointToWorld } = await import("@/lib/vector/games/time-to-fly/game");
      const world = mapClientPointToWorld({ left: 0, top: 0, width: 960, height: 540 }, 480, 270);

      expect(world).not.toBeNull();
      expect(world!.x).toBeCloseTo(TIME_TO_FLY_ARENA.WIDTH / 2, 6);
      expect(world!.y).toBeCloseTo(TIME_TO_FLY_ARENA.HEIGHT / 2, 6);
    });

    it("maps the left edge of a fitted canvas to the arena's west wall", async () => {
      const { mapClientPointToWorld } = await import("@/lib/vector/games/time-to-fly/game");
      // The arena is wider than it is tall relative to the viewport, so FIT
      // pins the zoom to the width and the horizontal edges coincide.
      const world = mapClientPointToWorld({ left: 0, top: 0, width: 960, height: 540 }, 0, 270);

      expect(world).not.toBeNull();
      expect(world!.x).toBeCloseTo(0, 6);
    });

    it("refuses a degenerate rect instead of dividing by zero", async () => {
      const { mapClientPointToWorld } = await import("@/lib/vector/games/time-to-fly/game");

      expect(mapClientPointToWorld({ left: 0, top: 0, width: 0, height: 0 }, 10, 10)).toBeNull();
    });
  });
});
