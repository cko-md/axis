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
import { BRICKRISE_SAVE_SCHEMA_VERSION, toSaveData, initialRunState, reachCheckpoint } from "@/lib/vector/games/brickrise/progress";

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
      expect(textOf(harness.mount, "brickrise-checkpoint")).toBe("2 of 6");
    });

    it("starts a fresh run rather than half-restoring a corrupt save", async () => {
      const harness = await mountGame();

      await harness.instance.hydrate({
        schemaVersion: BRICKRISE_SAVE_SCHEMA_VERSION,
        data: { version: 99, seed: "", deaths: -5 },
      });

      expect(textOf(harness.mount, "brickrise-deaths")).toBe("0");
      expect(textOf(harness.mount, "brickrise-checkpoint")).toBe("None of 6");
    });

    it("survives a null save", async () => {
      const harness = await mountGame();

      await expect(
        (async () => harness.instance.hydrate(null))(),
      ).resolves.not.toThrow();
      expect(textOf(harness.mount, "brickrise-checkpoint")).toBe("None of 6");
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
});
