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
const STYLE_ELEMENT_ID = "vector-second-sense-styles";
const DIAL_SIZE_PX = 260;

function injectStylesOnce(root: Document): void {
  if (root.getElementById(STYLE_ELEMENT_ID)) return;
  const style = root.createElement("style");
  style.id = STYLE_ELEMENT_ID;
  style.textContent = `
.${ROOT_CLASS} {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1.25rem;
  width: 100%;
  height: 100%;
  min-height: 100%;
  padding: 1.5rem 1rem;
  box-sizing: border-box;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  color: #ece8df;
  background: #0c0e13;
  overflow-y: auto;
}
.${ROOT_CLASS} * { box-sizing: border-box; }
.${ROOT_CLASS}__eyebrow { letter-spacing: 0.08em; text-transform: uppercase; font-size: 0.75rem; color: #a9a49a; }
.${ROOT_CLASS}__heading { margin: 0; font-size: 1.4rem; }
.${ROOT_CLASS}__body { margin: 0; max-width: 32rem; text-align: center; color: #cfc9bd; line-height: 1.5; }
.${ROOT_CLASS}__group { display: flex; gap: 0.5rem; flex-wrap: wrap; justify-content: center; }
.${ROOT_CLASS}__choice {
  min-height: 44px;
  min-width: 44px;
  padding: 0.6rem 1.1rem;
  border-radius: 8px;
  border: 1px solid #454033;
  background: #161a22;
  color: #ece8df;
  font-size: 0.95rem;
  cursor: pointer;
}
.${ROOT_CLASS}__choice[aria-pressed="true"] { background: #e0c388; color: #1a1c22; border-color: #e0c388; }
.${ROOT_CLASS}__choice:focus-visible { outline: 3px solid #7fb0ff; outline-offset: 2px; }
.${ROOT_CLASS}__start {
  min-height: 44px;
  padding: 0.7rem 1.6rem;
  border-radius: 8px;
  border: 1px solid #e0c388;
  background: #e0c388;
  color: #1a1c22;
  font-weight: 600;
  cursor: pointer;
}
.${ROOT_CLASS}__start:focus-visible { outline: 3px solid #7fb0ff; outline-offset: 2px; }
.${ROOT_CLASS}__start:disabled { opacity: 0.5; cursor: not-allowed; }
.${ROOT_CLASS}__stage { display: flex; flex-direction: column; align-items: center; gap: 1rem; }
.${ROOT_CLASS}__dial {
  width: ${DIAL_SIZE_PX}px;
  height: ${DIAL_SIZE_PX}px;
  max-width: 90vw;
  max-height: 90vw;
  touch-action: none;
}
.${ROOT_CLASS}__target {
  display: flex;
  align-items: center;
  justify-content: center;
  width: ${DIAL_SIZE_PX}px;
  height: ${DIAL_SIZE_PX}px;
  max-width: 90vw;
  max-height: 90vw;
  border-radius: 999px;
  border: 2px solid #454033;
  background: #161a22;
  cursor: pointer;
  touch-action: none;
  user-select: none;
}
.${ROOT_CLASS}__target[data-phase="holding"] { background: #2a2416; border-color: #e0c388; }
.${ROOT_CLASS}__target:focus-visible { outline: 3px solid #7fb0ff; outline-offset: 4px; }
.${ROOT_CLASS}__prompt { font-size: 1.1rem; text-align: center; }
.${ROOT_CLASS}__live { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
.${ROOT_CLASS}__results { display: flex; flex-direction: column; gap: 0.5rem; width: min(28rem, 100%); }
.${ROOT_CLASS}__result-row { display: flex; justify-content: space-between; padding: 0.4rem 0.6rem; border: 1px solid #33302a; border-radius: 6px; font-variant-numeric: tabular-nums; }
.${ROOT_CLASS}__summary { display: flex; flex-direction: column; gap: 0.25rem; align-items: center; text-align: center; }
.${ROOT_CLASS}__summary strong { font-size: 1.3rem; }
.${ROOT_CLASS}__actions { display: flex; gap: 0.75rem; }
.${ROOT_CLASS}__button {
  min-height: 44px;
  padding: 0.6rem 1.2rem;
  border-radius: 8px;
  border: 1px solid #454033;
  background: #161a22;
  color: #ece8df;
  cursor: pointer;
}
.${ROOT_CLASS}__button:focus-visible { outline: 3px solid #7fb0ff; outline-offset: 2px; }
@media (prefers-color-scheme: light) {
  .${ROOT_CLASS} { background: #f2ede2; color: #25231f; }
  .${ROOT_CLASS}__body { color: #4a453c; }
  .${ROOT_CLASS}__choice, .${ROOT_CLASS}__target, .${ROOT_CLASS}__button { background: #fbf8f2; border-color: #c8c0b0; color: #25231f; }
  .${ROOT_CLASS}__target[data-phase="holding"] { background: #f0dfae; border-color: #a3781f; }
  .${ROOT_CLASS}__result-row { border-color: #d8d0be; }
}
`;
  root.head.appendChild(style);
}

function drawDial(
  context: CanvasRenderingContext2D,
  size: number,
  input: {
    fillFraction: number;
    holding: boolean;
    revealed: { targetFraction: number; actualFraction: number } | null;
    reducedMotion: boolean;
  },
): void {
  const center = size / 2;
  const radius = center - 12;
  context.clearRect(0, 0, size, size);

  context.strokeStyle = "rgba(255,255,255,0.14)";
  context.lineWidth = 10;
  context.beginPath();
  context.arc(center, center, radius, 0, Math.PI * 2);
  context.stroke();

  if (input.revealed) {
    context.strokeStyle = "#7fb0ff";
    context.lineWidth = 10;
    context.beginPath();
    context.arc(
      center,
      center,
      radius,
      -Math.PI / 2,
      -Math.PI / 2 + Math.min(1, input.revealed.targetFraction) * Math.PI * 2,
    );
    context.stroke();

    context.strokeStyle = "#e0c388";
    context.lineWidth = 4;
    context.beginPath();
    context.arc(
      center,
      center,
      radius - 14,
      -Math.PI / 2,
      -Math.PI / 2 + Math.min(1, input.revealed.actualFraction) * Math.PI * 2,
    );
    context.stroke();
    return;
  }

  if (input.holding) {
    context.fillStyle = input.reducedMotion ? "rgba(224,195,136,0.35)" : "rgba(224,195,136,0.22)";
    context.beginPath();
    context.arc(center, center, radius - 20, 0, Math.PI * 2);
    context.fill();
    return;
  }

  context.strokeStyle = "#e0c388";
  context.lineWidth = 10;
  context.beginPath();
  context.arc(
    center,
    center,
    radius,
    -Math.PI / 2,
    -Math.PI / 2 + Math.min(1, Math.max(0, input.fillFraction)) * Math.PI * 2,
  );
  context.stroke();
}

/**
 * Build one Second Sense play instance. Framework-free: only DOM APIs and the
 * platform's VectorGameCreateContext are used, so the same function runs
 * inside the Next-hosted runtime and the standalone offline bootstrap.
 */
export function createSecondSenseGame(context: VectorGameCreateContext): VectorGameInstance {
  const doc = context.mount.ownerDocument ?? document;
  injectStylesOnce(doc);

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

  let dialCanvas: HTMLCanvasElement | null = null;
  let dialContext: CanvasRenderingContext2D | null = null;
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

    dialCanvas = doc.createElement("canvas");
    dialCanvas.className = `${ROOT_CLASS}__dial`;
    const scale = typeof window !== "undefined" ? Math.min(2, window.devicePixelRatio || 1) : 1;
    dialCanvas.width = DIAL_SIZE_PX * scale;
    dialCanvas.height = DIAL_SIZE_PX * scale;
    dialContext = dialCanvas.getContext("2d");
    dialContext?.scale(scale, scale);

    targetSurface = doc.createElement("div");
    targetSurface.className = `${ROOT_CLASS}__target`;
    targetSurface.setAttribute("role", "button");
    targetSurface.setAttribute("tabindex", "0");
    targetSurface.setAttribute("data-testid", "second-sense-hold-target");
    targetSurface.setAttribute("aria-pressed", "false");
    targetSurface.setAttribute("aria-label", "Hold and release when the interval has elapsed");
    targetSurface.appendChild(dialCanvas);
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
    if (!dialContext || !dialCanvas) return;
    const maxSpan = Math.max(targetMs, actualMs, 1);
    drawDial(dialContext, DIAL_SIZE_PX, {
      fillFraction: 0,
      holding: false,
      reducedMotion: settings.resolvedMotion === "reduced",
      revealed: { targetFraction: targetMs / maxSpan, actualFraction: actualMs / maxSpan },
    });
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
    if (!dialContext) return;
    drawDial(dialContext, DIAL_SIZE_PX, {
      fillFraction: demonstrationFraction(),
      holding: inputState.phase === "holding",
      revealed: null,
      reducedMotion: settings.resolvedMotion === "reduced",
    });
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
