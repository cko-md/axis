/**
 * Second Sense — the first playable VECTOR title (Wave 15.3).
 *
 * A hidden-interval reproduction game: each trial shows a target duration as
 * an animated dial sweep, then hides the dial and asks the player to
 * reproduce that duration by pressing and holding (keyboard, pointer, or
 * touch) and releasing when they believe the interval has elapsed. Five
 * trials per run; absolute and proportional timing error are scored
 * deterministically (see scoring.ts). Practice runs use a fresh random seed
 * per run; the daily challenge uses a seed derived from the UTC calendar day
 * (see rng.ts) so every player sees the same five targets on the same day.
 *
 * Native DOM + Canvas only — no game engine dependency. This module has no
 * React or Next.js import so the exact same code can run inside the VECTOR
 * platform (via lib/vector/loaders.ts) and inside the standalone offline
 * bootstrap (offline-bootstrap.ts), which is exactly what "cold launch
 * offline" requires: one engine, two hosts.
 */

import type {
  VectorGameCreateContext,
  VectorGameInstance,
  VectorGameModule,
  VectorRuntimeSettings,
  VectorSerializedSave,
} from "@/lib/vector/types";
import {
  generateSecondSenseTargets,
  secondSenseDailyChallengeKey,
  secondSenseSeedForChallenge,
  type SecondSenseDifficulty,
} from "@/lib/vector/games/second-sense/rng";
import {
  aggregateSecondSenseTrials,
  fromPersistedScore,
  scoreTrial,
  toPersistedScore,
  type SecondSenseTrialError,
  type SecondSenseTrialResult,
} from "@/lib/vector/games/second-sense/scoring";
import {
  INITIAL_SECOND_SENSE_INPUT_STATE,
  reduceSecondSenseInput,
  type SecondSenseInputState,
} from "@/lib/vector/games/second-sense/inputState";

export const SECOND_SENSE_SAVE_SCHEMA_VERSION = 1;

type SecondSenseMode = "practice" | "daily";
type SecondSensePhase = "select" | "running" | "complete";

export type SecondSenseSaveData = {
  phase: SecondSensePhase;
  mode: SecondSenseMode | null;
  difficulty: SecondSenseDifficulty | null;
  dailyKey: string | null;
  trialIndex: number;
  results: SecondSenseTrialResult[];
};

const ROOT_CLASS = "vector-second-sense";

// Wave 15.3 shipped a bespoke visual layer in this file: an injected stylesheet
// of hardcoded hex values and a canvas dial renderer, both of which bypassed the
// Atelier / VECTOR token systems. That layer has been removed so the visual
// design can be rebuilt against the shared design system.
//
// What deliberately remains is everything that is NOT design: the trial rules,
// the deterministic seeding, the input state machine, the scoring transform, and
// the accessibility contract. The class names below are kept as bare styling
// hooks (no stylesheet is injected), and every piece of trial state is exposed
// as DOM text plus data attributes — which is what the registry's accessibility
// claim ("all timing prompts, scores, state, and controls remain available as
// DOM text and buttons") actually rests on.

/**
 * Build one Second Sense play instance. Framework-free: only DOM APIs and the
 * platform's VectorGameCreateContext are used, so the same function runs
 * inside the Next-hosted runtime and the standalone offline bootstrap.
 */
export function createSecondSenseGame(context: VectorGameCreateContext): VectorGameInstance {
  const doc = context.mount.ownerDocument ?? document;

  const root = doc.createElement("div");
  root.className = ROOT_CLASS;
  root.setAttribute("data-testid", "second-sense-root");

  const live = doc.createElement("div");
  live.className = `${ROOT_CLASS}__live`;
  live.setAttribute("role", "status");
  live.setAttribute("aria-live", "polite");
  root.appendChild(live);

  let disposed = false;
  let unsubscribeScheduler: (() => void) | null = null;
  let settings: VectorRuntimeSettings = context.settings;

  let phase: SecondSensePhase = "select";
  let mode: SecondSenseMode | null = null;
  let difficulty: SecondSenseDifficulty | null = null;
  let dailyKey: string | null = null;
  let seed: string | null = null;
  let targets: number[] = [];
  let trialIndex = 0;
  let results: SecondSenseTrialResult[] = [];
  let inputState: SecondSenseInputState = INITIAL_SECOND_SENSE_INPUT_STATE;
  let demoStartedAtMs: number | null = null;
  let restoredSeed: string | null = null;

  function announce(message: string): void {
    live.textContent = message;
  }

  function currentTargetMs(): number {
    const value = targets[trialIndex];
    if (value === undefined) throw new Error("SECOND_SENSE_TRIAL_INDEX_OUT_OF_RANGE");
    return value;
  }

  function renderSelectScreen(): void {
    root.replaceChildren(live);
    const eyebrow = doc.createElement("div");
    eyebrow.className = `${ROOT_CLASS}__eyebrow`;
    eyebrow.textContent = "Second Sense";
    const heading = doc.createElement("h2");
    heading.className = `${ROOT_CLASS}__heading`;
    heading.textContent = "Measure time without seeing it.";
    const body = doc.createElement("p");
    body.className = `${ROOT_CLASS}__body`;
    body.textContent =
      "Five trials show a hidden interval, then hide the clock. Hold and release when you believe the interval has elapsed. Choose a mode and a difficulty to begin.";

    let selectedMode: SecondSenseMode = "practice";
    let selectedDifficulty: SecondSenseDifficulty = "easy";

    const modeGroup = doc.createElement("div");
    modeGroup.className = `${ROOT_CLASS}__group`;
    modeGroup.setAttribute("role", "group");
    modeGroup.setAttribute("aria-label", "Mode");
    const practiceButton = doc.createElement("button");
    practiceButton.type = "button";
    practiceButton.className = `${ROOT_CLASS}__choice`;
    practiceButton.textContent = "Practice";
    practiceButton.setAttribute("aria-pressed", "true");
    const dailyButton = doc.createElement("button");
    dailyButton.type = "button";
    dailyButton.className = `${ROOT_CLASS}__choice`;
    dailyButton.textContent = "Daily challenge";
    dailyButton.setAttribute("aria-pressed", "false");
    const setMode = (next: SecondSenseMode) => {
      selectedMode = next;
      practiceButton.setAttribute("aria-pressed", String(next === "practice"));
      dailyButton.setAttribute("aria-pressed", String(next === "daily"));
    };
    practiceButton.addEventListener("click", () => setMode("practice"));
    dailyButton.addEventListener("click", () => setMode("daily"));
    modeGroup.append(practiceButton, dailyButton);

    const difficultyGroup = doc.createElement("div");
    difficultyGroup.className = `${ROOT_CLASS}__group`;
    difficultyGroup.setAttribute("role", "group");
    difficultyGroup.setAttribute("aria-label", "Difficulty");
    const easyButton = doc.createElement("button");
    easyButton.type = "button";
    easyButton.className = `${ROOT_CLASS}__choice`;
    easyButton.textContent = "Easy — longer intervals, 1.5–4s";
    easyButton.setAttribute("aria-pressed", "true");
    const hardButton = doc.createElement("button");
    hardButton.type = "button";
    hardButton.className = `${ROOT_CLASS}__choice`;
    hardButton.textContent = "Hard — shorter intervals, 0.5–2.2s";
    hardButton.setAttribute("aria-pressed", "false");
    const setDifficulty = (next: SecondSenseDifficulty) => {
      selectedDifficulty = next;
      easyButton.setAttribute("aria-pressed", String(next === "easy"));
      hardButton.setAttribute("aria-pressed", String(next === "hard"));
    };
    easyButton.addEventListener("click", () => setDifficulty("easy"));
    hardButton.addEventListener("click", () => setDifficulty("hard"));
    difficultyGroup.append(easyButton, hardButton);

    const startButton = doc.createElement("button");
    startButton.type = "button";
    startButton.className = `${ROOT_CLASS}__start`;
    startButton.textContent = "Start";
    startButton.setAttribute("data-testid", "second-sense-start");
    startButton.addEventListener("click", () => {
      beginRun(selectedMode, selectedDifficulty);
    });

    root.append(eyebrow, heading, body, modeGroup, difficultyGroup, startButton);
    announce("Choose a mode and difficulty, then start.");
  }

  function beginRun(nextMode: SecondSenseMode, nextDifficulty: SecondSenseDifficulty): void {
    mode = nextMode;
    difficulty = nextDifficulty;
    dailyKey = nextMode === "daily" ? secondSenseDailyChallengeKey(new Date()) : null;
    seed = restoredSeed && restoredSeed.length > 0
      ? restoredSeed
      : nextMode === "daily"
        ? secondSenseSeedForChallenge("daily", { dailyKey: dailyKey ?? undefined })
        : secondSenseSeedForChallenge("practice", { practiceSeed: crypto.randomUUID() });
    restoredSeed = null;
    targets = generateSecondSenseTargets(seed, nextDifficulty);
    trialIndex = 0;
    results = [];
    phase = "running";
    context.emit({
      type: "run.start",
      occurredAt: new Date().toISOString(),
      metadata: { mode: nextMode === "daily" ? "daily" : "solo", difficulty: nextDifficulty },
    });
    startTrial();
  }

  let demoTimeoutHandle: ReturnType<typeof setTimeout> | null = null;

  function clearDemoTimeout(): void {
    if (demoTimeoutHandle !== null) {
      clearTimeout(demoTimeoutHandle);
      demoTimeoutHandle = null;
    }
  }

  function startTrial(): void {
    clearDemoTimeout();
    inputState = reduceSecondSenseInput(INITIAL_SECOND_SENSE_INPUT_STATE, { type: "trialStart" });
    demoStartedAtMs = typeof performance !== "undefined" ? performance.now() : Date.now();
    renderRunningScreen();
    announce(
      `Trial ${trialIndex + 1} of ${targets.length}. Demonstrating a ${currentTargetMs()} millisecond interval.`,
    );
    demoTimeoutHandle = setTimeout(() => {
      demoTimeoutHandle = null;
      inputState = reduceSecondSenseInput(inputState, { type: "demoComplete" });
      demoStartedAtMs = null;
      if (promptElement) {
        promptElement.textContent = "Hold now. Release when you believe the interval has elapsed.";
      }
      announce("Hold now. Release when you believe the interval has elapsed.");
      renderDial();
    }, currentTargetMs());
  }

  // Stands in for the removed canvas dial. It carries the same information the
  // dial encoded — sweep progress, hold state, and the target/actual reveal —
  // as text and data attributes, so a redesign can bind a new visual to these
  // without re-deriving any timing.
  let dialReadout: HTMLDivElement | null = null;
  let targetSurface: HTMLDivElement | null = null;
  let promptElement: HTMLParagraphElement | null = null;

  function renderRunningScreen(): void {
    root.replaceChildren(live);
    const eyebrow = doc.createElement("div");
    eyebrow.className = `${ROOT_CLASS}__eyebrow`;
    eyebrow.textContent = `Trial ${trialIndex + 1} of ${targets.length} · ${difficulty === "hard" ? "Hard" : "Easy"} · ${mode === "daily" ? "Daily" : "Practice"}`;

    promptElement = doc.createElement("p");
    promptElement.className = `${ROOT_CLASS}__prompt`;
    promptElement.textContent = "Watch the interval.";

    const stage = doc.createElement("div");
    stage.className = `${ROOT_CLASS}__stage`;

    dialReadout = doc.createElement("div");
    dialReadout.className = `${ROOT_CLASS}__dial`;
    dialReadout.setAttribute("data-testid", "second-sense-dial");
    dialReadout.setAttribute("aria-hidden", "true");

    targetSurface = doc.createElement("div");
    targetSurface.className = `${ROOT_CLASS}__target`;
    targetSurface.setAttribute("role", "button");
    targetSurface.setAttribute("tabindex", "0");
    targetSurface.setAttribute("data-testid", "second-sense-hold-target");
    targetSurface.setAttribute("aria-pressed", "false");
    targetSurface.setAttribute("aria-label", "Hold and release when the interval has elapsed");
    targetSurface.appendChild(dialReadout);
    bindHoldTarget(targetSurface);

    stage.appendChild(targetSurface);
    root.append(eyebrow, promptElement, stage);
    renderDial();
  }

  function eventTimeMs(event: { timeStamp: number }): number {
    return Number.isFinite(event.timeStamp) ? event.timeStamp : performance.now();
  }

  function bindHoldTarget(target: HTMLDivElement): void {
    const onHoldStart = (atMs: number) => {
      if (inputState.phase !== "armed") return;
      inputState = reduceSecondSenseInput(inputState, { type: "holdStart", atMs });
      target.setAttribute("data-phase", "holding");
      target.setAttribute("aria-pressed", "true");
      if (promptElement) promptElement.textContent = "Holding… release when you believe the interval has elapsed.";
      renderDial();
    };
    const onHoldEnd = (atMs: number) => {
      if (inputState.phase !== "holding") return;
      inputState = reduceSecondSenseInput(inputState, { type: "holdEnd", atMs });
      target.setAttribute("data-phase", "released");
      target.setAttribute("aria-pressed", "false");
      completeTrial(inputState.heldForMs ?? 0);
    };

    target.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      onHoldStart(eventTimeMs(event));
    });
    target.addEventListener("pointerup", (event) => onHoldEnd(eventTimeMs(event)));
    target.addEventListener("pointercancel", (event) => onHoldEnd(eventTimeMs(event)));
    target.addEventListener("keydown", (event) => {
      if (event.code !== "Space" && event.key !== " ") return;
      event.preventDefault();
      if (event.repeat) return;
      onHoldStart(eventTimeMs(event));
    });
    target.addEventListener("keyup", (event) => {
      if (event.code !== "Space" && event.key !== " ") return;
      event.preventDefault();
      onHoldEnd(eventTimeMs(event));
    });
  }

  let pendingAdvance: (() => void) | null = null;
  let advanceTimeoutHandle: ReturnType<typeof setTimeout> | null = null;

  function clearAdvanceTimeout(): void {
    if (advanceTimeoutHandle !== null) {
      clearTimeout(advanceTimeoutHandle);
      advanceTimeoutHandle = null;
    }
  }

  function completeTrial(heldForMs: number): void {
    const targetMs = currentTargetMs();
    const trial: SecondSenseTrialResult = { targetMs, actualMs: heldForMs };
    results = [...results, trial];
    const scored: SecondSenseTrialError = scoreTrial(trial);
    announce(
      `You held for ${heldForMs} milliseconds. Absolute error ${Math.round(scored.absoluteErrorMs)} milliseconds, ${(scored.proportionalError * 100).toFixed(1)} percent proportional error.`,
    );
    context.emit({
      type: "checkpoint",
      occurredAt: new Date().toISOString(),
      metadata: { round: trialIndex + 1 },
    });
    renderRevealed(targetMs, heldForMs);

    pendingAdvance = () => {
      pendingAdvance = null;
      trialIndex += 1;
      if (trialIndex >= targets.length) {
        finishRun();
      } else {
        startTrial();
      }
    };
    clearAdvanceTimeout();
    advanceTimeoutHandle = setTimeout(() => {
      advanceTimeoutHandle = null;
      pendingAdvance?.();
    }, settings.resolvedMotion === "reduced" ? 600 : 1400);
  }

  function renderRevealed(targetMs: number, actualMs: number): void {
    if (!dialReadout) return;
    const maxSpan = Math.max(targetMs, actualMs, 1);
    dialReadout.dataset.state = "revealed";
    dialReadout.dataset.targetFraction = String(targetMs / maxSpan);
    dialReadout.dataset.actualFraction = String(actualMs / maxSpan);
    delete dialReadout.dataset.fillFraction;
    dialReadout.textContent = `Target ${targetMs}ms · held ${actualMs}ms`;
  }

  function demonstrationFraction(): number {
    if (inputState.phase !== "demonstrating" || demoStartedAtMs === null) return 0;
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    const raw = Math.min(1, Math.max(0, (now - demoStartedAtMs) / currentTargetMs()));
    if (settings.resolvedMotion !== "reduced") return raw;
    // Reduced motion keeps the same real-time interval (the semantics of the
    // trial are unchanged) but replaces the smooth 60fps sweep with ten
    // discrete steps, matching "changes feedback, not semantics."
    return Math.floor(raw * 10) / 10;
  }

  function renderDial(): void {
    if (!dialReadout) return;
    const holding = inputState.phase === "holding";
    const fillFraction = demonstrationFraction();
    dialReadout.dataset.state = holding ? "holding" : "sweeping";
    dialReadout.dataset.fillFraction = String(fillFraction);
    dialReadout.dataset.reducedMotion = String(settings.resolvedMotion === "reduced");
    delete dialReadout.dataset.targetFraction;
    delete dialReadout.dataset.actualFraction;
    dialReadout.textContent = holding
      ? "Holding"
      : `Demonstrating ${Math.round(fillFraction * 100)}%`;
  }

  function scoreMode(): "practice" | "daily" {
    return mode === "daily" ? "daily" : "practice";
  }

  function finishRun(): void {
    phase = "complete";
    const aggregate = aggregateSecondSenseTrials(results.map(scoreTrial));
    const persistedScore = toPersistedScore(aggregate.meanAbsoluteErrorMs);
    const totalDurationMs = results.reduce((sum, trial) => sum + trial.actualMs, 0);
    context.emit({
      type: "run.complete",
      occurredAt: new Date().toISOString(),
      metadata: {
        mode: mode === "daily" ? "daily" : "solo",
        difficulty: difficulty ?? "easy",
        outcome: "complete",
        score: persistedScore,
        durationMs: totalDurationMs,
      },
    });
    const scoreInput = {
      mode: scoreMode(),
      challengeId: mode === "daily" ? dailyKey : null,
      value: persistedScore,
    };
    void context.recordScore?.(scoreInput);
    renderCompleteScreen(aggregate.meanAbsoluteErrorMs, aggregate.meanProportionalError);
    announce(
      `Run complete. Mean absolute error ${Math.round(aggregate.meanAbsoluteErrorMs)} milliseconds across ${results.length} trials.`,
    );

    if (context.getBestScore) {
      void context.getBestScore({
        mode: scoreInput.mode,
        challengeId: scoreInput.challengeId,
      }).then((best) => {
        if (phase !== "complete" || best === null) return;
        const bestEl = root.querySelector<HTMLElement>("[data-testid='second-sense-personal-best']");
        if (bestEl) {
          bestEl.textContent =
            `Personal best (this ${scoreInput.mode === "daily" ? "daily challenge" : "mode"}): ${Math.round(fromPersistedScore(best))} ms mean absolute error`;
        }
      }).catch(() => undefined);
    }
  }

  function renderCompleteScreen(meanAbsoluteErrorMs: number, meanProportionalError: number): void {
    root.replaceChildren(live);
    const eyebrow = doc.createElement("div");
    eyebrow.className = `${ROOT_CLASS}__eyebrow`;
    eyebrow.textContent = `Run complete · ${difficulty === "hard" ? "Hard" : "Easy"} · ${mode === "daily" ? "Daily" : "Practice"}`;

    const summary = doc.createElement("div");
    summary.className = `${ROOT_CLASS}__summary`;
    const summaryHeading = doc.createElement("strong");
    summaryHeading.textContent = `${Math.round(meanAbsoluteErrorMs)} ms mean absolute error`;
    const summaryBody = doc.createElement("span");
    summaryBody.textContent = `${(meanProportionalError * 100).toFixed(1)}% mean proportional error across ${results.length} trials`;
    const bestEl = doc.createElement("span");
    bestEl.setAttribute("data-testid", "second-sense-personal-best");
    bestEl.textContent = context.getBestScore
      ? "Checking your personal best…"
      : "Personal best is unavailable in this session.";
    summary.append(summaryHeading, summaryBody, bestEl);

    const table = doc.createElement("div");
    table.className = `${ROOT_CLASS}__results`;
    results.forEach((trial, index) => {
      const scored = scoreTrial(trial);
      const row = doc.createElement("div");
      row.className = `${ROOT_CLASS}__result-row`;
      row.textContent =
        `Trial ${index + 1}: target ${trial.targetMs}ms, held ${trial.actualMs}ms, error ${Math.round(scored.absoluteErrorMs)}ms`;
      table.appendChild(row);
    });

    const actions = doc.createElement("div");
    actions.className = `${ROOT_CLASS}__actions`;
    const again = doc.createElement("button");
    again.type = "button";
    again.className = `${ROOT_CLASS}__button`;
    again.textContent = "Play again";
    again.setAttribute("data-testid", "second-sense-play-again");
    again.addEventListener("click", () => {
      phase = "select";
      renderSelectScreen();
    });
    actions.append(again);

    root.append(eyebrow, summary, table, actions);
  }

  function currentSeedForSave(): string | null {
    return seed;
  }

  const instance: VectorGameInstance = {
    initialize() {
      context.mount.replaceChildren(root);
      unsubscribeScheduler = context.scheduler.subscribe(() => {
        // Only the demonstration phase needs a per-frame redraw (the sweep
        // tracks real elapsed time); every other phase draws once from the
        // event that caused its state change.
        if (inputState.phase === "demonstrating") renderDial();
      });
      renderSelectScreen();
      context.emit({ type: "runtime.ready", occurredAt: new Date().toISOString() });
    },

    hydrate(save: VectorSerializedSave | null) {
      if (!save || !save.data || typeof save.data !== "object") {
        phase = "select";
        return;
      }
      const data = save.data as Partial<SecondSenseSaveData>;
      if (
        data.phase === "running"
        && data.mode
        && data.difficulty
        && Array.isArray(data.results)
        && typeof data.trialIndex === "number"
        && save.seed
      ) {
        mode = data.mode;
        difficulty = data.difficulty;
        dailyKey = data.dailyKey ?? null;
        restoredSeed = save.seed;
        seed = save.seed;
        targets = generateSecondSenseTargets(save.seed, data.difficulty);
        trialIndex = Math.min(data.trialIndex, targets.length - 1);
        results = data.results.filter(
          (item): item is SecondSenseTrialResult =>
            typeof item?.targetMs === "number" && typeof item?.actualMs === "number",
        );
        phase = "running";
        return;
      }
      phase = "select";
    },

    start() {
      if (phase === "running" && targets.length > 0) {
        startTrial();
      }
    },

    pause() {
      // A hold or demonstration spanning a pause is not fair to score or
      // watch (the browser may throttle timers while backgrounded, and the
      // player cannot see the tab). Cancel any in-flight attempt without
      // penalty and stop the demo/inter-trial timers; resume() re-presents
      // the same trial cleanly, or replays the pending advance, so no trial
      // is silently skipped, unfairly scored, or double-scored.
      clearDemoTimeout();
      clearAdvanceTimeout();
      if (inputState.phase !== "released" || pendingAdvance === null) {
        inputState = INITIAL_SECOND_SENSE_INPUT_STATE;
        demoStartedAtMs = null;
      }
    },

    resume() {
      if (phase !== "running") return;
      if (pendingAdvance) {
        pendingAdvance();
        return;
      }
      if (inputState.phase === "idle") {
        startTrial();
      }
    },

    serialize(): VectorSerializedSave {
      const data: SecondSenseSaveData = {
        phase,
        mode,
        difficulty,
        dailyKey,
        trialIndex,
        results,
      };
      return {
        schemaVersion: SECOND_SENSE_SAVE_SCHEMA_VERSION,
        data,
        seed: currentSeedForSave() ?? undefined,
      };
    },

    reset() {
      clearDemoTimeout();
      clearAdvanceTimeout();
      pendingAdvance = null;
      demoStartedAtMs = null;
      phase = "select";
      mode = null;
      difficulty = null;
      dailyKey = null;
      seed = null;
      targets = [];
      trialIndex = 0;
      results = [];
      inputState = INITIAL_SECOND_SENSE_INPUT_STATE;
      renderSelectScreen();
    },

    updateSettings(next: VectorRuntimeSettings) {
      settings = next;
      renderDial();
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      clearDemoTimeout();
      clearAdvanceTimeout();
      pendingAdvance = null;
      unsubscribeScheduler?.();
      unsubscribeScheduler = null;
      context.mount.replaceChildren();
    },
  };

  return instance;
}

export const secondSenseGameModule: VectorGameModule = {
  createGame: createSecondSenseGame,
};

export default secondSenseGameModule;
