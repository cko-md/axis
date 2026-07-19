// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSecondSenseGame, SECOND_SENSE_SAVE_SCHEMA_VERSION } from "@/lib/vector/games/second-sense/game";
import {
  generateSecondSenseTargets,
  secondSenseSeedForChallenge,
} from "@/lib/vector/games/second-sense/rng";
import {
  aggregateSecondSenseTrials,
  scoreTrial,
  toPersistedScore,
} from "@/lib/vector/games/second-sense/scoring";
import type {
  VectorGameCreateContext,
  VectorGameScoreInput,
  VectorRuntimeEvent,
  VectorRuntimeFrame,
  VectorRuntimeScheduler,
  VectorRuntimeSettings,
} from "@/lib/vector/types";

const FIXED_PRACTICE_UUID = "00000000-0000-4000-8000-000000000000";
const SETTINGS: VectorRuntimeSettings = {
  motionPreference: "system",
  resolvedMotion: "standard",
  muted: false,
  volume: 0.7,
  lowPower: false,
};

function fakeScheduler(): VectorRuntimeScheduler {
  const listeners = new Set<(frame: VectorRuntimeFrame) => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start() {},
    stop() {},
    dispose() {
      listeners.clear();
    },
    isRunning: () => false,
  };
}

function buildContext(overrides: Partial<VectorGameCreateContext> = {}) {
  const mount = document.createElement("div");
  const events: VectorRuntimeEvent[] = [];
  const scores: VectorGameScoreInput[] = [];
  const context: VectorGameCreateContext = {
    mount,
    manifest: {} as VectorGameCreateContext["manifest"],
    settings: SETTINGS,
    scheduler: fakeScheduler(),
    emit: (event) => events.push(event),
    recordScore: (input) => {
      scores.push(input);
    },
    ...overrides,
  };
  return { context, mount, events, scores };
}

function dispatchKey(target: Element, type: "keydown" | "keyup") {
  target.dispatchEvent(new KeyboardEvent(type, { code: "Space", key: " ", bubbles: true }));
}

/**
 * jsdom does not implement 2D canvas rendering (it would need the native
 * `canvas` package). The game already treats a missing context as a no-op
 * draw, so stub a minimal context here purely to keep jsdom's "not
 * implemented" console noise out of the test log — nothing in this suite
 * asserts on actual pixels.
 */
function stubCanvasContext() {
  const context = {
    clearRect: () => {},
    beginPath: () => {},
    arc: () => {},
    stroke: () => {},
    fill: () => {},
    scale: () => {},
  } as unknown as CanvasRenderingContext2D;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
}

describe("second sense game module", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(crypto, "randomUUID").mockReturnValue(FIXED_PRACTICE_UUID);
    stubCanvasContext();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("mounts a mode/difficulty select screen on initialize", async () => {
    const { context, mount } = buildContext();
    const instance = createSecondSenseGame(context);
    await instance.initialize();
    await instance.hydrate(null);

    expect(mount.querySelector('[data-testid="second-sense-start"]')).not.toBeNull();
    expect(mount.textContent).toMatch(/Measure time without seeing it/);
  });

  it("emits runtime.ready exactly once on initialize", async () => {
    const { context, events } = buildContext();
    const instance = createSecondSenseGame(context);
    await instance.initialize();

    expect(events.filter((event) => event.type === "runtime.ready")).toHaveLength(1);
  });

  it("plays a full deterministic practice run and records a matching score", async () => {
    const { context, mount, events, scores } = buildContext();
    const instance = createSecondSenseGame(context);
    await instance.initialize();
    await instance.hydrate(null);
    await instance.start();

    const startButton = mount.querySelector<HTMLButtonElement>(
      '[data-testid="second-sense-start"]',
    );
    expect(startButton).not.toBeNull();
    startButton?.click();

    const seed = secondSenseSeedForChallenge("practice", { practiceSeed: FIXED_PRACTICE_UUID });
    const targets = generateSecondSenseTargets(seed, "easy");
    expect(targets).toHaveLength(5);

    for (let trial = 0; trial < targets.length; trial += 1) {
      // Advance past the demonstration so the hold target becomes armed.
      await vi.advanceTimersByTimeAsync(targets[trial] + 1);
      const holdTarget = mount.querySelector<HTMLDivElement>(
        '[data-testid="second-sense-hold-target"]',
      );
      expect(holdTarget).not.toBeNull();
      expect(holdTarget?.getAttribute("aria-pressed")).toBe("false");

      // Press and immediately release: an (approximately) zero-length hold,
      // fully deterministic regardless of clock domain, since no time
      // advances between the two dispatches.
      dispatchKey(holdTarget!, "keydown");
      expect(holdTarget?.getAttribute("aria-pressed")).toBe("true");
      dispatchKey(holdTarget!, "keyup");
      expect(holdTarget?.getAttribute("aria-pressed")).toBe("false");

      if (trial < targets.length - 1) {
        // Between-trial delay before the next trial's demonstration begins.
        await vi.advanceTimersByTimeAsync(1500);
      }
    }

    await vi.advanceTimersByTimeAsync(1500);

    expect(mount.querySelector('[data-testid="second-sense-play-again"]')).not.toBeNull();

    const expectedResults = targets.map((targetMs) => ({ targetMs, actualMs: 0 }));
    const expectedAggregate = aggregateSecondSenseTrials(expectedResults.map(scoreTrial));
    const expectedScore = toPersistedScore(expectedAggregate.meanAbsoluteErrorMs);

    const completeEvent = events.find((event) => event.type === "run.complete");
    expect(completeEvent?.metadata?.mode).toBe("solo");
    expect(completeEvent?.metadata?.difficulty).toBe("easy");
    expect(completeEvent?.metadata?.outcome).toBe("complete");
    expect(completeEvent?.metadata?.score).toBe(expectedScore);

    expect(scores).toHaveLength(1);
    expect(scores[0]).toEqual({
      mode: "practice",
      challengeId: null,
      value: expectedScore,
    });
  });

  it("requests and displays the personal best via getBestScore for the run's mode/challenge", async () => {
    const bestScoreCalls: { mode: string; challengeId: string | null }[] = [];
    const { context, mount } = buildContext({
      getBestScore: async (input) => {
        bestScoreCalls.push(input);
        return 999_000;
      },
    });
    const instance = createSecondSenseGame(context);
    await instance.initialize();
    await instance.hydrate(null);
    await instance.start();
    mount.querySelector<HTMLButtonElement>('[data-testid="second-sense-start"]')?.click();

    const seed = secondSenseSeedForChallenge("practice", { practiceSeed: FIXED_PRACTICE_UUID });
    const targets = generateSecondSenseTargets(seed, "easy");
    for (const target of targets) {
      await vi.advanceTimersByTimeAsync(target + 1);
      const holdTarget = mount.querySelector<HTMLDivElement>(
        '[data-testid="second-sense-hold-target"]',
      );
      dispatchKey(holdTarget!, "keydown");
      dispatchKey(holdTarget!, "keyup");
      await vi.advanceTimersByTimeAsync(1500);
    }

    expect(bestScoreCalls).toEqual([{ mode: "practice", challengeId: null }]);
    const bestEl = mount.querySelector('[data-testid="second-sense-personal-best"]');
    expect(bestEl?.textContent).toMatch(/Personal best.*1000 ms mean absolute error/);
  });

  it("ignores a repeated keydown while already holding (keyboard auto-repeat)", async () => {
    const { context, mount } = buildContext();
    const instance = createSecondSenseGame(context);
    await instance.initialize();
    await instance.hydrate(null);
    await instance.start();
    mount.querySelector<HTMLButtonElement>('[data-testid="second-sense-start"]')?.click();

    const seed = secondSenseSeedForChallenge("practice", { practiceSeed: FIXED_PRACTICE_UUID });
    const targets = generateSecondSenseTargets(seed, "easy");
    await vi.advanceTimersByTimeAsync(targets[0] + 1);

    const holdTarget = mount.querySelector<HTMLDivElement>(
      '[data-testid="second-sense-hold-target"]',
    );
    holdTarget!.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", key: " ", bubbles: true }));
    expect(holdTarget?.getAttribute("aria-pressed")).toBe("true");
    // Auto-repeat keydown while held must not restart the hold or throw.
    holdTarget!.dispatchEvent(
      new KeyboardEvent("keydown", { code: "Space", key: " ", bubbles: true, repeat: true }),
    );
    expect(holdTarget?.getAttribute("aria-pressed")).toBe("true");
  });

  it("cancels an in-flight hold on pause without scoring it, and re-presents the same trial on resume", async () => {
    const { context, mount } = buildContext();
    const instance = createSecondSenseGame(context);
    await instance.initialize();
    await instance.hydrate(null);
    await instance.start();
    mount.querySelector<HTMLButtonElement>('[data-testid="second-sense-start"]')?.click();

    const seed = secondSenseSeedForChallenge("practice", { practiceSeed: FIXED_PRACTICE_UUID });
    const targets = generateSecondSenseTargets(seed, "easy");
    await vi.advanceTimersByTimeAsync(targets[0] + 1);

    const holdTarget = mount.querySelector<HTMLDivElement>(
      '[data-testid="second-sense-hold-target"]',
    );
    dispatchKey(holdTarget!, "keydown");
    expect(holdTarget?.getAttribute("aria-pressed")).toBe("true");

    await instance.pause("visibility");
    // The serialized state must not have recorded a phantom trial result.
    const saved = await instance.serialize();
    expect((saved.data as { results: unknown[] }).results).toHaveLength(0);

    await instance.resume();
    const restartedTarget = mount.querySelector<HTMLDivElement>(
      '[data-testid="second-sense-hold-target"]',
    );
    expect(restartedTarget).not.toBeNull();
    expect(restartedTarget?.getAttribute("aria-pressed")).toBe("false");
  });

  it("serializes and rehydrates mid-run state, resuming at the same trial", async () => {
    const first = buildContext();
    const instanceA = createSecondSenseGame(first.context);
    await instanceA.initialize();
    await instanceA.hydrate(null);
    await instanceA.start();
    first.mount.querySelector<HTMLButtonElement>('[data-testid="second-sense-start"]')?.click();

    const seed = secondSenseSeedForChallenge("practice", { practiceSeed: FIXED_PRACTICE_UUID });
    const targets = generateSecondSenseTargets(seed, "easy");
    await vi.advanceTimersByTimeAsync(targets[0] + 1);
    const holdTargetA = first.mount.querySelector<HTMLDivElement>(
      '[data-testid="second-sense-hold-target"]',
    );
    dispatchKey(holdTargetA!, "keydown");
    dispatchKey(holdTargetA!, "keyup");
    // Capture mid-run save before the between-trial timer advances further.
    const midRunSave = await instanceA.serialize();
    expect(midRunSave.schemaVersion).toBe(SECOND_SENSE_SAVE_SCHEMA_VERSION);
    expect((midRunSave.data as { trialIndex: number }).trialIndex).toBe(0);
    expect((midRunSave.data as { results: unknown[] }).results).toHaveLength(1);
    expect(midRunSave.seed).toBe(seed);
    await instanceA.dispose();

    const second = buildContext();
    const instanceB = createSecondSenseGame(second.context);
    await instanceB.initialize();
    await instanceB.hydrate(midRunSave);
    await instanceB.start();

    expect(
      second.mount.querySelector('[data-testid="second-sense-hold-target"]'),
    ).not.toBeNull();
    const resumedSave = await instanceB.serialize();
    expect((resumedSave.data as { trialIndex: number }).trialIndex).toBe(0);
    expect((resumedSave.data as { results: unknown[] }).results).toHaveLength(1);
  });

  it("ignores an unparseable save and starts fresh at the select screen", async () => {
    const { context, mount } = buildContext();
    const instance = createSecondSenseGame(context);
    await instance.initialize();
    await instance.hydrate({ schemaVersion: 1, data: { garbage: true } });
    expect(mount.querySelector('[data-testid="second-sense-start"]')).not.toBeNull();
  });

  it("disposes cleanly, clearing the mount and pending timers", async () => {
    const { context, mount } = buildContext();
    const instance = createSecondSenseGame(context);
    await instance.initialize();
    await instance.hydrate(null);
    await instance.start();
    mount.querySelector<HTMLButtonElement>('[data-testid="second-sense-start"]')?.click();
    await instance.dispose();
    expect(mount.childElementCount).toBe(0);
    // No further timer callbacks should throw after teardown.
    await vi.advanceTimersByTimeAsync(10_000);
  });
});
