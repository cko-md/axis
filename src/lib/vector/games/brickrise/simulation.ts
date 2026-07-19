/**
 * Brickrise simulation — the per-step orchestration, pure and DOM-free.
 *
 * physics.ts decides how a body moves, level.ts decides what it moves through,
 * progress.ts decides what a run remembers. This module is the fourth piece:
 * the exact ORDER those three are consulted in on a single fixed step, and what
 * a step reports back.
 *
 * It lives apart from game.ts on purpose. The renderer is the one part of this
 * game that cannot be tested without a canvas, so everything that decides what
 * is true — including "does dying also bank a checkpoint on the same frame" —
 * is kept on this side of the boundary where a test can reach it. Phaser draws
 * the result; it never participates in producing it.
 */

import {
  type BodyState,
  type Box,
  boxesOverlap,
  BRICKRISE_PHYSICS,
  placeBodyAt,
  stepBody,
} from "@/lib/vector/games/brickrise/physics";
import {
  type BrickriseLevel,
  checkpointTriggerBox,
  hasReachedSummit,
  solidBoxesFor,
} from "@/lib/vector/games/brickrise/level";
import {
  type BrickriseRunState,
  advanceElapsed,
  completeRun,
  reachCheckpoint,
  recordDeath,
  respawnPosition,
} from "@/lib/vector/games/brickrise/progress";
import {
  type BrickriseInputState,
  directionFrom,
  INITIAL_BRICKRISE_INPUT,
  reduceBrickriseInput,
} from "@/lib/vector/games/brickrise/inputState";

/**
 * Things a step can report. The renderer turns these into feedback and the
 * game shell turns them into runtime events and announcements; neither is
 * allowed to re-derive them by diffing state, which is how the two surfaces
 * drift apart.
 */
export type BrickriseStepEvent =
  | { type: "death"; deaths: number; respawnCheckpointIndex: number | null }
  | { type: "checkpoint"; index: number; total: number }
  | { type: "summit"; elapsedMs: number; deaths: number };

export type BrickriseSimulation = Readonly<{
  level: BrickriseLevel;
  run: BrickriseRunState;
  body: BodyState;
  input: BrickriseInputState;
  /** Solid geometry, resolved once per level rather than per step. */
  solids: readonly Box[];
}>;

export type BrickriseStepResult = Readonly<{
  simulation: BrickriseSimulation;
  events: readonly BrickriseStepEvent[];
}>;

/**
 * Build a simulation for a run, placing the body at its respawn point — spawn
 * for a fresh run, the highest checkpoint reached for a restored one.
 */
export function createBrickriseSimulation(
  run: BrickriseRunState,
  level: BrickriseLevel,
  body: BodyState,
): BrickriseSimulation {
  const position = respawnPosition(run, level);
  return {
    level,
    run,
    body: placeBodyAt(body, position.x, position.y),
    input: INITIAL_BRICKRISE_INPUT,
    solids: solidBoxesFor(level),
  };
}

/** Apply an input action without advancing the simulation. */
export function applyBrickriseInput(
  simulation: BrickriseSimulation,
  action: Parameters<typeof reduceBrickriseInput>[1],
): BrickriseSimulation {
  return { ...simulation, input: reduceBrickriseInput(simulation.input, action) };
}

function isFatal(body: BodyState, level: BrickriseLevel): boolean {
  return level.hazards.some((hazard) => boxesOverlap(body.box, hazard));
}

/**
 * Advance exactly one fixed step.
 *
 * A completed run is inert: elapsed time stops accruing the moment the summit
 * is reached, so a result left on screen does not quietly inflate the score
 * that gets persisted.
 */
export function stepBrickriseSimulation(simulation: BrickriseSimulation): BrickriseStepResult {
  if (simulation.run.completed) return { simulation, events: [] };

  const events: BrickriseStepEvent[] = [];

  const intent = {
    direction: directionFrom(simulation.input),
    jumpHeld: simulation.input.jumpHeld,
    jumpPressed: simulation.input.jumpPressed,
  };

  let body = stepBody(simulation.body, intent, simulation.solids);
  // The jump edge lives exactly one step and is consumed above; clearing it
  // here rather than at the call site means a caller cannot forget and give a
  // held key a jump on every frame.
  let input = reduceBrickriseInput(simulation.input, { type: "frame" });
  // Fixed, never wall-clock: a variable delta would make the persisted score
  // depend on the machine that produced it.
  let run = advanceElapsed(simulation.run, BRICKRISE_PHYSICS.FIXED_TIMESTEP_MS);

  if (isFatal(body, simulation.level)) {
    run = recordDeath(run);
    const position = respawnPosition(run, simulation.level);
    body = placeBodyAt(body, position.x, position.y);
    // Release held inputs on death: a key still down through a respawn would
    // walk the body off its checkpoint before the player has reacted.
    input = INITIAL_BRICKRISE_INPUT;
    events.push({
      type: "death",
      deaths: run.deaths,
      respawnCheckpointIndex: run.checkpointIndex,
    });
    // A fatal step banks nothing else. Overlapping a checkpoint and a spike on
    // the same frame must not award progress the player did not survive.
    return { simulation: { ...simulation, run, body, input }, events };
  }

  for (const checkpoint of simulation.level.checkpoints) {
    if (!boxesOverlap(body.box, checkpointTriggerBox(checkpoint))) continue;
    const before = run.checkpointIndex;
    run = reachCheckpoint(run, checkpoint.index);
    // reachCheckpoint is monotonic, so re-entering a lower checkpoint is a
    // no-op — only report a genuine advance.
    if (run.checkpointIndex !== before) {
      events.push({
        type: "checkpoint",
        index: checkpoint.index,
        total: simulation.level.checkpoints.length,
      });
    }
  }

  if (hasReachedSummit(simulation.level, body.box.y + body.box.height)) {
    run = completeRun(run);
    events.push({ type: "summit", elapsedMs: run.elapsedMs, deaths: run.deaths });
  }

  return { simulation: { ...simulation, run, body, input }, events };
}
