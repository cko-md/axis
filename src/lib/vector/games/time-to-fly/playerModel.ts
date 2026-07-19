/**
 * Time to Fly — the reference player model. Pure, DOM-free, deterministic.
 *
 * ADR-0006's central finding is that a provably-solvable level is not the
 * same as a solvable level: the design it rejected generated levels whose
 * solutions existed and were humanly unfindable. This module is the direct
 * consequence — an executable definition of "a player can find it", used
 * twice:
 *
 *  - by level.ts as the FINAL acceptance gate: a candidate level that this
 *    protocol cannot solve is rejected at generation time, exactly the way
 *    Brickrise's generator guarantees floor reachability rather than hoping
 *    for it;
 *  - by solvability.test.ts as the blocking regression test, which runs a
 *    STRICTLY LARGER protocol against the real generator's output — so if
 *    the gate is ever weakened or removed, the test still catches the
 *    regression.
 *
 * The model is deliberately non-omniscient. It only ever LAUNCHES and
 * observes the flight — no verifier, no solution list, no trajectory
 * preview (the binding spec forbids one). What it records per launch is
 * exactly what a player watches on screen: which planets' fields the craft
 * visibly swung through, how close it came to the galaxy, whether it
 * arrived. Each observation replays the launch with the REAL integrator —
 * the same stepCraft chain the shell will fly, bit for bit — never a
 * shortcut, never an analytic fast-forward.
 *
 * The protocol is the reasoning ADR-0006 promises the disjoint-field
 * design supports, made concrete:
 *
 *  1. SECTOR HANDOFFS, left to right. Planet k's slot decides the line into
 *     disc k+1, and planet k+1's slot decides whether that line is caught
 *     and carried on — so the player tunes the PAIR together, keeps
 *     whichever pairing carried the flight furthest along the chain
 *     (breaking ties by closest approach, then lowest slots), locks the
 *     upstream dial, and moves one sector right.
 *  2. REFINEMENT PROBES before committing: the few best-looking pairs each
 *     get a quick twelve-launch sweep of the NEXT dial — "before I settle
 *     these two, can the third planet actually finish from here?" — because
 *     a wrong tour that happens to drift near the galaxy cannot be refined
 *     by the next dial, while the true tour visibly can. Measured on real
 *     levels: the deceptive tours beat the true one by 30 px of approach in
 *     the pair sweep, and lost by 200+ px under the probe.
 *  3. Optionally more ROUNDS of 1-2, and a TAIL POLISH endgame: return to
 *     the best flight seen and fine-tune its last few dials in pairs — the
 *     joint adjustments a left-to-right pass never tries.
 *
 * Budgets are closed-form from the protocol shape, not tuned numbers, and
 * everything is bounded and deterministic: ties resolve to the lowest slot,
 * every launch is counted, and exhausting the budget is a hard failure.
 */

import {
  TIME_TO_FLY_ARENA,
  TIME_TO_FLY_PHYSICS,
  TIME_TO_FLY_SLOT_COUNT,
  type TimeToFlyVector,
} from "@/lib/vector/games/time-to-fly/constants";
import { launchState, placePlanets, stepCraft } from "@/lib/vector/games/time-to-fly/flight";
import type { TimeToFlyArrangement, TimeToFlyPlanet } from "@/lib/vector/games/time-to-fly/orbit";

/** What the model needs of a level — satisfied by TimeToFlyLevel. */
export type PlayableLevel = Readonly<{
  planets: readonly TimeToFlyPlanet[];
  galaxy: TimeToFlyVector;
  initialArrangement: TimeToFlyArrangement;
}>;

export type PlayerProtocol = Readonly<{
  /** Full left-to-right sector-handoff rounds. */
  rounds: number;
  /** How many best-looking pairs earn a next-dial refinement probe. */
  shortlist: number;
  /** Whether the tail-polish endgame runs after the rounds. */
  tailPolish: boolean;
}>;

/**
 * The generation-time gate: one full round, no endgame. Levels the protocol
 * cannot crack in a single systematic pass are rejected rather than shipped.
 * Kept lean because it runs inside the generator's accept loop.
 */
export const TIME_TO_FLY_GATE_PROTOCOL: PlayerProtocol = Object.freeze({
  rounds: 1,
  shortlist: 8,
  tailPolish: false,
});

/**
 * The regression-test protocol: a strict superset of the gate (same first
 * round, then a second round and the endgame). Anything the gate accepted,
 * this solves within its first round — and if the gate is ever weakened,
 * this protocol is what catches the fallout.
 */
export const TIME_TO_FLY_FULL_PROTOCOL: PlayerProtocol = Object.freeze({
  rounds: 2,
  shortlist: 8,
  tailPolish: true,
});

export type PlayerObservation = Readonly<{
  arrived: boolean;
  /** Consecutive fields entered from planet 0 — the visible chain progress. */
  progress: number;
  approach: number;
}>;

export type PlayerResult = Readonly<{
  solved: boolean;
  launches: number;
  budget: number;
  bestProgress: number;
  bestApproach: number;
}>;

/**
 * The closed-form launch budget of a protocol on an N-planet level: each
 * round costs one 144-launch pair sweep per handoff sector, a 12-launch solo
 * sweep of the last planet, and the refinement probes; the tail polish adds
 * one pair sweep per tail pair.
 */
export function playerLaunchBudget(planetCount: number, protocol: PlayerProtocol): number {
  const slots = TIME_TO_FLY_SLOT_COUNT;
  const pairSweep = slots * slots;
  const perRound =
    (planetCount - 1) * pairSweep
    + slots
    + Math.max(0, planetCount - 2) * protocol.shortlist * slots;
  const tailDials = protocol.tailPolish ? Math.min(3, planetCount) : 0;
  const tailPairs = (tailDials * (tailDials - 1)) / 2;
  return protocol.rounds * perRound + tailPairs * pairSweep;
}

/**
 * One launch, watched. Steps the identical trajectory the shell would fly
 * (the same stepCraft calls in the same order as simulateFlight) while
 * recording the on-screen facts: fields entered, closest approach, arrival.
 */
export function launchAndWatch(
  level: PlayableLevel,
  candidate: TimeToFlyArrangement,
): PlayerObservation {
  const placed = placePlanets(level.planets, candidate);
  const entered = level.planets.map(() => false);
  let craft = launchState();
  let approach = Number.POSITIVE_INFINITY;
  let arrived = false;

  for (let step = 1; step <= TIME_TO_FLY_PHYSICS.MAX_FLIGHT_STEPS; step += 1) {
    craft = stepCraft(craft, placed);

    const dxg = craft.position.x - level.galaxy.x;
    const dyg = craft.position.y - level.galaxy.y;
    const toGalaxy = Math.sqrt(dxg * dxg + dyg * dyg);
    if (toGalaxy < approach) approach = toGalaxy;
    if (toGalaxy <= TIME_TO_FLY_ARENA.GALAXY_RADIUS) {
      arrived = true;
      break;
    }

    let dead = false;
    for (let index = 0; index < placed.length; index += 1) {
      const planet = placed[index];
      const dx = craft.position.x - planet.position.x;
      const dy = craft.position.y - planet.position.y;
      const toPlanet = Math.sqrt(dx * dx + dy * dy);
      if (toPlanet < planet.fieldRadius) entered[index] = true;
      if (toPlanet <= planet.bodyRadius + TIME_TO_FLY_PHYSICS.SHIP_RADIUS) dead = true;
    }
    if (dead) break;

    const margin = TIME_TO_FLY_ARENA.OUT_OF_BOUNDS_MARGIN;
    if (
      craft.position.x < -margin
      || craft.position.y < -margin
      || craft.position.x > TIME_TO_FLY_ARENA.WIDTH + margin
      || craft.position.y > TIME_TO_FLY_ARENA.HEIGHT + margin
    ) {
      break;
    }
  }

  let progress = 0;
  while (progress < entered.length && entered[progress]) progress += 1;
  return { arrived, progress, approach };
}

/** Run the protocol against a level. Deterministic, bounded, non-omniscient. */
export function solveAsPlayer(level: PlayableLevel, protocol: PlayerProtocol): PlayerResult {
  const budget = playerLaunchBudget(level.planets.length, protocol);
  const planetCount = level.planets.length;
  let launches = 0;
  let bestProgress = 0;
  let bestApproach = Number.POSITIVE_INFINITY;
  const arrangement: number[] = [...level.initialArrangement];

  const solvedResult = (): PlayerResult => ({
    solved: true,
    launches,
    budget,
    bestProgress: planetCount,
    bestApproach: 0,
  });
  const failedResult = (): PlayerResult => ({
    solved: false,
    launches,
    budget,
    bestProgress,
    bestApproach,
  });

  let outOfBudget = false;
  let bestArrangement: number[] = [...arrangement];
  const watch = (candidate: readonly number[]): PlayerObservation | null => {
    if (launches >= budget) {
      outOfBudget = true;
      return null;
    }
    launches += 1;
    const seen = launchAndWatch(level, candidate);
    if (
      seen.progress > bestProgress
      || (seen.progress === bestProgress && seen.approach < bestApproach)
    ) {
      bestArrangement = [...candidate];
    }
    if (seen.progress > bestProgress) bestProgress = seen.progress;
    if (seen.approach < bestApproach) bestApproach = seen.approach;
    return seen;
  };

  const better = (a: PlayerObservation, b: PlayerObservation | null): boolean =>
    b === null || a.progress > b.progress || (a.progress === b.progress && a.approach < b.approach);

  for (let round = 0; round < protocol.rounds; round += 1) {
    for (let sector = 0; sector < planetCount; sector += 1) {
      const partner = sector + 1 < planetCount ? sector + 1 : null;
      const pairs: { slot: number; partnerSlot: number; seen: PlayerObservation }[] = [];

      for (let slot = 0; slot < TIME_TO_FLY_SLOT_COUNT; slot += 1) {
        const partnerSlots = partner !== null
          ? Array.from({ length: TIME_TO_FLY_SLOT_COUNT }, (_, index) => index)
          : [0];
        for (const partnerSlot of partnerSlots) {
          const candidate = arrangement.slice();
          candidate[sector] = slot;
          if (partner !== null) candidate[partner] = partnerSlot;
          const seen = watch(candidate);
          if (seen === null) return failedResult();
          if (seen.arrived) return solvedResult();
          pairs.push({ slot, partnerSlot, seen });
        }
      }

      pairs.sort(
        (a, b) =>
          b.seen.progress - a.seen.progress
          || a.seen.approach - b.seen.approach
          || a.slot - b.slot
          || a.partnerSlot - b.partnerSlot,
      );

      let bestPair = pairs[0];
      const nextDial = partner !== null && partner + 1 < planetCount ? partner + 1 : null;
      if (nextDial !== null) {
        // Refinement probe — see the module header. The re-ranking is by the
        // best flight each shortlisted pair achieves with the NEXT dial
        // swept, which separates true tours from lucky drifts.
        let bestRefined: PlayerObservation | null = null;
        for (const pair of pairs.slice(0, protocol.shortlist)) {
          for (let slot = 0; slot < TIME_TO_FLY_SLOT_COUNT; slot += 1) {
            const candidate = arrangement.slice();
            candidate[sector] = pair.slot;
            if (partner !== null) candidate[partner] = pair.partnerSlot;
            candidate[nextDial] = slot;
            const seen = watch(candidate);
            if (seen === null) return failedResult();
            if (seen.arrived) return solvedResult();
            if (better(seen, bestRefined)) {
              bestRefined = seen;
              bestPair = pair;
            }
          }
        }
      }

      arrangement[sector] = bestPair.slot;
      // The partner's winning slot is a lead, not a lock — its own sector
      // pass comes next and may overturn it.
      if (partner !== null) arrangement[partner] = bestPair.partnerSlot;
    }
    if (outOfBudget) break;
  }

  if (protocol.tailPolish) {
    // Endgame: return to the closest flight seen and fine-tune its last few
    // dials in pairs — the joint adjustments a left-to-right pass never
    // tries. bestArrangement keeps updating as the polish improves, so the
    // search re-centres on every new best, like a player would.
    const tailDials = Math.min(3, planetCount);
    for (let first = planetCount - tailDials; first < planetCount; first += 1) {
      for (let second = first + 1; second < planetCount; second += 1) {
        for (let slotA = 0; slotA < TIME_TO_FLY_SLOT_COUNT; slotA += 1) {
          for (let slotB = 0; slotB < TIME_TO_FLY_SLOT_COUNT; slotB += 1) {
            const candidate = bestArrangement.slice();
            candidate[first] = slotA;
            candidate[second] = slotB;
            const seen = watch(candidate);
            if (seen === null) return failedResult();
            if (seen.arrived) return solvedResult();
          }
        }
      }
    }
  }

  return failedResult();
}
