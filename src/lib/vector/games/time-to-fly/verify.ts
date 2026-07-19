/**
 * Time to Fly — level verification. Pure, DOM-free, deterministic.
 *
 * Answers the three questions the binding spec asks of every generated level:
 *
 *   1. Is it solvable at all?
 *   2. Does EVERY planet materially contribute to EVERY valid solution?
 *   3. Are there only a SMALL number of valid solutions?
 *
 * None of these can be play-tested in; the generator must guarantee them and
 * this module must prove them, for every seed, in bounded time.
 *
 * ── Why an exhaustive answer is affordable ───────────────────────────────────
 * Naively the solution space is 24^N — nearly 8 million arrangements at five
 * planets. What makes it tractable is the disjoint-reach-disc invariant from
 * ADR-0006: because no two planets' fields can ever overlap, the craft is under
 * the influence of at most one planet at a time, and its path is fixed until it
 * enters some planet's reach disc. So instead of enumerating arrangements, this
 * walks the flight and branches ONLY when the craft arrives at a disc whose
 * planet has no slot assigned yet. Every branch that crashes, leaves the arena,
 * or reaches the galaxy terminates immediately, which prunes the overwhelming
 * majority of the lattice without ever visiting it.
 *
 * Slots of planets the craft never approaches are FREE — they cannot affect the
 * outcome. Those are expanded into the reported solution set rather than
 * searched, which is both faster and more honest: a level in which a planet can
 * be ignored is exactly a level that fails requirement 2, and it is caught by
 * `necessity` below rather than hidden by the search.
 *
 * The node budget is fail-closed. Exhausting it reports `exhausted: true` and
 * the level is REJECTED, never accepted on a partial count — an undercount
 * would silently turn "three solutions" into "one".
 */

import {
  TIME_TO_FLY_ARENA,
  TIME_TO_FLY_PHYSICS,
  TIME_TO_FLY_SLOT_COUNT,
  type TimeToFlyVector,
} from "@/lib/vector/games/time-to-fly/constants";
import {
  type CraftState,
  type PlacedPlanet,
  launchState,
  stepCraft,
} from "@/lib/vector/games/time-to-fly/flight";
import {
  type TimeToFlyArrangement,
  type TimeToFlyPlanet,
  planetClassOf,
  planetPositionAt,
  reachRadius,
} from "@/lib/vector/games/time-to-fly/orbit";

/** Ceiling on nodes expanded per level. Exceeding it rejects, never accepts. */
export const TIME_TO_FLY_NODE_BUDGET = 60_000;

/**
 * Cosine of the widest angle the craft's heading can still swing through, given
 * how many planets it has not yet met.
 *
 * This is the prune that makes exhaustive verification affordable. Without it
 * the search is brute force: measured node counts tracked the full 24^N lattice
 * almost exactly (601 nodes for a 576-arrangement lattice), because a branch
 * only died by crashing or leaving the arena, and in a spread-out chain most
 * branches simply fly on to the next disc.
 *
 * Each fly-by can rotate the velocity by at most that class's maximum
 * deflection — measured at 19/35/44 degrees for small/medium/large
 * (flight.test.ts). So over R remaining planets the heading cannot rotate more
 * than R * 45 degrees, taking 45 as a bound above every class. If neither the
 * galaxy nor any unmet planet's reach disc lies inside that cone, this branch
 * provably cannot reach the galaxy and is discarded unexplored.
 *
 * Admissible: it never prunes a branch that could have arrived, so the solution
 * count stays exact. Hardcoded cosines rather than an angle sum, because the
 * prune decides which arrangements are counted — if it disagreed across engines
 * by one ulp, two machines could accept different levels for the same seed.
 */
const HEADING_CONE_COSINE: readonly number[] = Object.freeze([
  1, //                      0 remaining: must already be pointing at the galaxy
  0.7071067811865476, //     1 remaining: 45 degrees
  0, //                      2 remaining: 90 degrees
  -0.7071067811865476, //    3 remaining: 135 degrees
  -1, //                     4+ remaining: unbounded, no prune possible
]);

export type VerificationResult = Readonly<{
  /** Every arrangement that reaches the galaxy. */
  solutions: readonly TimeToFlyArrangement[];
  /** True if the search ran out of budget — the result is then untrustworthy. */
  exhausted: boolean;
  nodesUsed: number;
  /** Closest approach of the best solution; drives the clean-arrival gate. */
  bestApproach: number;
  /**
   * Closest approach of any NON-solution branch that got near the galaxy.
   * A near-miss sitting just outside the capture radius means the level is
   * decided by a margin the player cannot see.
   */
  nearestMiss: number;
}>;

function distance(a: TimeToFlyVector, b: TimeToFlyVector): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function outOfBounds(position: TimeToFlyVector): boolean {
  const margin = TIME_TO_FLY_ARENA.OUT_OF_BOUNDS_MARGIN;
  return (
    position.x < -margin
    || position.y < -margin
    || position.x > TIME_TO_FLY_ARENA.WIDTH + margin
    || position.y > TIME_TO_FLY_ARENA.HEIGHT + margin
  );
}

/**
 * Is `target` (a point, optionally with a radius) inside the cone of headings
 * the craft can still swing onto? Uses only dot products and sqrt, so it is
 * bit-identical everywhere.
 */
function targetInCone(
  craft: CraftState,
  target: TimeToFlyVector,
  targetRadius: number,
  coneCosine: number,
): boolean {
  const dx = target.x - craft.position.x;
  const dy = target.y - craft.position.y;
  const range = Math.sqrt(dx * dx + dy * dy);
  // Already on top of it — trivially reachable.
  if (range <= targetRadius) return true;

  const speed = Math.sqrt(craft.velocity.x * craft.velocity.x + craft.velocity.y * craft.velocity.y);
  if (speed === 0) return false;

  const alignment = (dx * craft.velocity.x + dy * craft.velocity.y) / (range * speed);
  // Widen the cone by the angle the target's own radius subtends, so a large
  // disc just off the cone edge is not wrongly discarded.
  const subtended = targetRadius / range;
  return alignment >= coneCosine - subtended;
}

function withinReachableCone(
  craft: CraftState,
  pending: readonly { index: number; centre: TimeToFlyVector; radius: number }[],
  galaxy: TimeToFlyVector,
): boolean {
  const remaining = pending.length;
  const coneCosine = HEADING_CONE_COSINE[Math.min(remaining, HEADING_CONE_COSINE.length - 1)];
  // Four or more planets left: the heading can still swing anywhere, so no
  // branch can be ruled out.
  if (coneCosine <= -1) return true;

  if (targetInCone(craft, galaxy, TIME_TO_FLY_ARENA.GALAXY_RADIUS, coneCosine)) return true;
  for (const disc of pending) {
    if (targetInCone(craft, disc.centre, disc.radius, coneCosine)) return true;
  }
  return false;
}

type MarchEvent =
  | { kind: "arrived"; approach: number; steps: number }
  | { kind: "crashed"; steps: number; approach: number }
  | { kind: "escaped"; steps: number; approach: number }
  | { kind: "reached-disc"; planetIndex: number; craft: CraftState; steps: number; approach: number }
  | { kind: "abandoned-planet"; steps: number; approach: number };

/**
 * Step the craft forward until something decisive happens.
 *
 * Stepped, never fast-forwarded, even through vacuum — see flight.ts. The
 * verifier's flight has to be the same flight the player watches, bit for bit.
 */
function march(
  craft: CraftState,
  placed: readonly PlacedPlanet[],
  visited: Set<number>,
  pending: readonly { index: number; centre: TimeToFlyVector; radius: number }[],
  galaxy: TimeToFlyVector,
  stepsUsed: number,
  approachSoFar: number,
): MarchEvent {
  let current = craft;
  let approach = approachSoFar;

  for (let step = stepsUsed + 1; step <= TIME_TO_FLY_PHYSICS.MAX_FLIGHT_STEPS; step += 1) {
    current = stepCraft(current, placed);

    // A planet whose field the craft has left behind without ever entering can
    // never contribute to this branch. That is not a solution under the
    // threading rule, and no later step can repair it, so the branch dies here.
    for (const planet of placed) {
      if (visited.has(planet.id)) continue;
      const toPlanet = distance(current.position, planet.position);
      if (toPlanet < planet.fieldRadius) {
        visited.add(planet.id);
        continue;
      }
      const receding =
        (current.position.x - planet.position.x) * current.velocity.x
        + (current.position.y - planet.position.y) * current.velocity.y;
      if (receding > 0 && toPlanet > planet.fieldRadius) {
        return { kind: "abandoned-planet", steps: step, approach };
      }
    }

    const toGalaxy = distance(current.position, galaxy);
    if (toGalaxy < approach) approach = toGalaxy;
    if (toGalaxy <= TIME_TO_FLY_ARENA.GALAXY_RADIUS) {
      return { kind: "arrived", approach: toGalaxy, steps: step };
    }

    for (const planet of placed) {
      if (distance(current.position, planet.position) <= planet.bodyRadius + TIME_TO_FLY_PHYSICS.SHIP_RADIUS) {
        return { kind: "crashed", steps: step, approach };
      }
    }

    if (outOfBounds(current.position)) return { kind: "escaped", steps: step, approach };

    // Entering an unassigned planet's reach disc is the only branch point.
    for (const candidate of pending) {
      if (distance(current.position, candidate.centre) <= candidate.radius) {
        return { kind: "reached-disc", planetIndex: candidate.index, craft: current, steps: step, approach };
      }
    }
  }

  return { kind: "escaped", steps: TIME_TO_FLY_PHYSICS.MAX_FLIGHT_STEPS, approach };
}

/**
 * Enumerate every arrangement that reaches the galaxy.
 *
 * Exhaustive over the whole 24^N lattice in effect, but it visits only branches
 * the craft can actually distinguish.
 */
export function verifyLevel(
  planets: readonly TimeToFlyPlanet[],
  galaxy: TimeToFlyVector,
  nodeBudget: number = TIME_TO_FLY_NODE_BUDGET,
): VerificationResult {
  const solutions: TimeToFlyArrangement[] = [];
  let nodes = 0;
  let exhausted = false;
  let bestApproach = Number.POSITIVE_INFINITY;
  let nearestMiss = Number.POSITIVE_INFINITY;

  const discs = planets.map((planet, index) => ({
    index,
    centre: planet.orbitCenter,
    radius: reachRadius(planet),
  }));

  /** Expand an assignment with free slots into every concrete arrangement. */
  function recordSolution(assigned: readonly (number | null)[]): void {
    const freeIndices = assigned.flatMap((slot, index) => (slot === null ? [index] : []));
    if (freeIndices.length === 0) {
      solutions.push(assigned.map((slot) => slot ?? 0));
      return;
    }
    // Under the threading rule a planet the craft never met cannot appear in a
    // solution at all, so this expansion should be unreachable. Kept as a
    // total function rather than an assertion, and the count stays exact.
    const total = TIME_TO_FLY_SLOT_COUNT ** freeIndices.length;
    for (let combo = 0; combo < total; combo += 1) {
      const arrangement = assigned.map((slot) => slot ?? 0);
      let rest = combo;
      for (const index of freeIndices) {
        arrangement[index] = rest % TIME_TO_FLY_SLOT_COUNT;
        rest = Math.floor(rest / TIME_TO_FLY_SLOT_COUNT);
      }
      solutions.push(arrangement);
    }
  }

  function search(
    craft: CraftState,
    assigned: (number | null)[],
    stepsUsed: number,
    approachSoFar: number,
    visitedIds: readonly number[],
  ): void {
    if (exhausted) return;
    nodes += 1;
    if (nodes > nodeBudget) {
      exhausted = true;
      return;
    }

    const placed: PlacedPlanet[] = [];
    const pending: { index: number; centre: TimeToFlyVector; radius: number }[] = [];
    assigned.forEach((slot, index) => {
      if (slot === null) {
        pending.push(discs[index]);
        return;
      }
      const klass = planetClassOf(planets[index]);
      placed.push({
        id: planets[index].id,
        position: planetPositionAt(planets[index], slot),
        mass: klass.mass,
        bodyRadius: klass.bodyRadius,
        fieldRadius: klass.fieldRadius,
      });
    });

    // Admissible bound: can this branch still reach the galaxy at all?
    if (!withinReachableCone(craft, pending, galaxy)) return;

    const visited = new Set(visitedIds);
    const event = march(craft, placed, visited, pending, galaxy, stepsUsed, approachSoFar);

    if (event.kind === "arrived") {
      // THREADING RULE: reaching the galaxy is necessary but not sufficient —
      // the craft must have been deflected by every planet. This is what makes
      // "every planet materially contributes" structural rather than a property
      // we hope the geometry happens to have, and it is what kills the branches
      // that made exhaustive counting unaffordable.
      if (visited.size < planets.length) {
        if (event.approach < nearestMiss) nearestMiss = event.approach;
        return;
      }
      if (event.approach < bestApproach) bestApproach = event.approach;
      recordSolution(assigned);
      return;
    }
    if (event.kind === "crashed" || event.kind === "escaped" || event.kind === "abandoned-planet") {
      if (event.approach < nearestMiss) nearestMiss = event.approach;
      return;
    }

    // Branch: the craft has arrived at a disc whose planet is still unplaced.
    for (let slot = 0; slot < TIME_TO_FLY_SLOT_COUNT; slot += 1) {
      if (exhausted) return;
      const next = assigned.slice();
      next[event.planetIndex] = slot;
      search(event.craft, next, event.steps, event.approach, [...visited]);
    }
  }

  search(launchState(), planets.map(() => null), 0, Number.POSITIVE_INFINITY, []);

  return { solutions, exhausted, nodesUsed: nodes, bestApproach, nearestMiss };
}

/**
 * Does every planet materially contribute?
 *
 * The spec sentence is "every planet materially contributes to each valid
 * solution", and the faithful reading is ablation: remove planet k and the
 * level must become unsolvable. If it does not, then some solution never needed
 * k, and k is decoration.
 *
 * Cheap here precisely because removing a planet only makes the search smaller.
 */
export function everyPlanetNecessary(
  planets: readonly TimeToFlyPlanet[],
  galaxy: TimeToFlyVector,
  nodeBudget: number = TIME_TO_FLY_NODE_BUDGET,
): boolean {
  for (let omit = 0; omit < planets.length; omit += 1) {
    const ablated = planets.filter((_, index) => index !== omit);
    const result = verifyLevel(ablated, galaxy, nodeBudget);
    // An exhausted ablation is not evidence of unsolvability, so fail closed.
    if (result.exhausted) return false;
    if (result.solutions.length > 0) return false;
  }
  return true;
}
