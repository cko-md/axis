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
import type { TimeToFlyPlanetClass } from "@/lib/vector/games/time-to-fly/constants";

/** Ceiling on nodes expanded per level. Exceeding it rejects, never accepts. */
export const TIME_TO_FLY_NODE_BUDGET = 60_000;

/**
 * Per-class turn capacity: cosine and sine of an upper bound on the deflection
 * a single fly-by of that class can produce.
 *
 * This feeds the prune that makes exhaustive verification affordable. Without
 * it the search is brute force: measured node counts tracked the full 24^N
 * lattice almost exactly (601 nodes for a 576-arrangement lattice), because a
 * branch only died by crashing or leaving the arena, and in a spread-out chain
 * most branches simply fly on to the next disc.
 *
 * The bounds are MEASURED, not assumed. An earlier revision assumed 45 degrees
 * per planet, quoting flight.test.ts's 19/35/44-degree figures — but those were
 * measured only down to the generator's own minimum impact parameter. The
 * verifier explores every slot, including passes that skim just above the crash
 * radius, and a 0.5 px sweep over ALL survivable impact parameters measures the
 * true maxima at 21.7 / 45.5 / 79.0 degrees for small/medium/large. The
 * 45-degree assumption therefore silently deleted real solutions involving a
 * deep pass of a large planet, which mis-rejected levels as unsolvable and —
 * worse — mis-ACCEPTED levels whose true solution count was above the gate.
 * verify.test.ts re-measures the maxima and asserts these bounds stay above
 * them, so a physics retune cannot quietly break admissibility.
 *
 * Bounds carry a 3-degree margin: small 25, medium 49, large 83 degrees.
 * Hardcoded cos/sin literals rather than computed angles, because the prune
 * decides which arrangements are counted — if it disagreed across engines by
 * one ulp, two machines could accept different levels for the same seed.
 */
export const CLASS_TURN_CAPACITY: Readonly<
  Record<TimeToFlyPlanetClass, Readonly<{ cos: number; sin: number }>>
> = Object.freeze({
  small: Object.freeze({ cos: 0.9063077870366499, sin: 0.42261826174069944 }), //  25 deg
  medium: Object.freeze({ cos: 0.6560590289905073, sin: 0.754709580222772 }), //   49 deg
  large: Object.freeze({ cos: 0.12186934340514749, sin: 0.992546151641322 }), //   83 deg
});

/**
 * Cosine of the total heading swing still available to the craft, summed over
 * a list of not-yet-flown planet classes — or null when the sum reaches 180
 * degrees, at which point no direction can be ruled out and no prune is
 * possible.
 *
 * Computed by exact angle addition on the hardcoded cos/sin literals:
 * cos(a+b) = cos a * cos b - sin a * sin b, sin(a+b) = sin a * cos b +
 * cos a * sin b. Multiplication and subtraction only, so the result is
 * bit-identical everywhere, which matters because this value decides which
 * arrangements get counted.
 */
function coneCosineFor(classes: readonly TimeToFlyPlanetClass[]): number | null {
  let cos = 1;
  let sin = 0;
  for (const klass of classes) {
    const turn = CLASS_TURN_CAPACITY[klass];
    const nextCos = cos * turn.cos - sin * turn.sin;
    const nextSin = sin * turn.cos + cos * turn.sin;
    // Each addend is under 90 degrees, so sine stays non-negative until the
    // running total passes 180 — the moment the cone covers every heading.
    if (nextSin < 0) return null;
    cos = nextCos;
    sin = nextSin;
  }
  return cos;
}

export type VerificationResult = Readonly<{
  /** Every arrangement that reaches the galaxy. */
  solutions: readonly TimeToFlyArrangement[];
  /** True if the search ran out of budget — the result is then untrustworthy. */
  exhausted: boolean;
  /**
   * True if the search stopped early because the solution count passed the
   * caller's cap. The enumerated set is then a PREFIX of the true solution set:
   * fine for "too many" or "at least one" decisions, useless for exact counts.
   */
  capped: boolean;
  nodesUsed: number;
  /** Closest approach of the best solution; diagnostic. */
  bestApproach: number;
  /**
   * Perpendicular distance from the galaxy centre to the line of flight at the
   * capture step, for the best-aimed solution. This — not bestApproach — is
   * what the clean-arrival gate reads. The distinction matters: the first
   * sampled position inside the capture disc lands anywhere in
   * [radius - speed, radius] regardless of how well the shot was aimed, so a
   * gate on bestApproach rejected ~93% of dead-centre solutions for the phase
   * of the final step, which the player cannot even influence. Aim error is
   * phase-free.
   */
  bestAim: number;
  /**
   * Closest approach of any NON-solution branch that got near the galaxy.
   * A near-miss sitting just outside the capture radius means the level is
   * decided by a margin the player cannot see. (Still step-sampled, so it can
   * over-read the true minimum by up to one step length — acceptable for a
   * safety margin, unlike the arrival gate above.)
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
  pending: readonly { index: number; centre: TimeToFlyVector; radius: number; planetClass: TimeToFlyPlanetClass }[],
  galaxy: TimeToFlyVector,
  justAssigned: TimeToFlyPlanetClass | null,
): boolean {
  // Every deflection still ahead of the craft: each pending planet's, PLUS the
  // planet assigned at this very node. A branch node sits at the rim of the
  // just-assigned planet's reach disc, BEFORE its field has bent anything —
  // omitting it undercounts the remaining turn capacity by one planet and
  // silently deletes real solutions (measured: the constructed solution itself,
  // at every level, whenever the galaxy was not already dead ahead).
  const ahead: TimeToFlyPlanetClass[] = pending.map((disc) => disc.planetClass);
  if (justAssigned !== null) ahead.push(justAssigned);

  const coneCosine = coneCosineFor(ahead);
  // Total capacity reaches 180 degrees: no heading can be ruled out.
  if (coneCosine === null) return true;

  if (targetInCone(craft, galaxy, TIME_TO_FLY_ARENA.GALAXY_RADIUS, coneCosine)) return true;
  for (const disc of pending) {
    if (targetInCone(craft, disc.centre, disc.radius, coneCosine)) return true;
  }
  return false;
}

type MarchEvent =
  | { kind: "arrived"; approach: number; aim: number; steps: number }
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
      // Aim error: perpendicular distance from the galaxy centre to the line
      // of flight at the capture step. |cross(galaxy - pos, v)| / |v| — only
      // multiply, subtract, divide and sqrt, per the determinism rule.
      const vx = current.velocity.x;
      const vy = current.velocity.y;
      const speed = Math.sqrt(vx * vx + vy * vy);
      const offX = galaxy.x - current.position.x;
      const offY = galaxy.y - current.position.y;
      const aim = speed === 0 ? toGalaxy : Math.abs(offX * vy - offY * vx) / speed;
      return { kind: "arrived", approach: toGalaxy, aim, steps: step };
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
  /**
   * Stop enumerating once MORE than this many solutions exist. The generator
   * rejects any level over its solution ceiling, so counting the 200th
   * solution of a hopeless candidate is pure waste; a cap turns the dominant
   * rejection path from O(solutions) into O(cap). Pass POSITIVE_INFINITY (the
   * default) for a complete count.
   */
  solutionCap: number = Number.POSITIVE_INFINITY,
  /**
   * TEST ONLY: disable the heading-cone prune so tests can prove the pruned
   * and unpruned searches count identical solution sets. Production callers
   * must leave this true.
   */
  pruneWithCone = true,
): VerificationResult {
  const solutions: TimeToFlyArrangement[] = [];
  let nodes = 0;
  let exhausted = false;
  let capped = false;
  let bestApproach = Number.POSITIVE_INFINITY;
  let bestAim = Number.POSITIVE_INFINITY;
  let nearestMiss = Number.POSITIVE_INFINITY;

  const discs = planets.map((planet, index) => ({
    index,
    centre: planet.orbitCenter,
    radius: reachRadius(planet),
    planetClass: planet.planetClass,
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
    justAssigned: TimeToFlyPlanetClass | null,
  ): void {
    if (exhausted || capped) return;
    nodes += 1;
    if (nodes > nodeBudget) {
      exhausted = true;
      return;
    }

    const placed: PlacedPlanet[] = [];
    const pending: { index: number; centre: TimeToFlyVector; radius: number; planetClass: TimeToFlyPlanetClass }[] = [];
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
    if (pruneWithCone && !withinReachableCone(craft, pending, galaxy, justAssigned)) return;

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
      if (event.aim < bestAim) bestAim = event.aim;
      recordSolution(assigned);
      if (solutions.length > solutionCap) capped = true;
      return;
    }
    if (event.kind === "crashed" || event.kind === "escaped" || event.kind === "abandoned-planet") {
      if (event.approach < nearestMiss) nearestMiss = event.approach;
      return;
    }

    // Branch: the craft has arrived at a disc whose planet is still unplaced.
    // The recursion carries that planet's class into the child node's cone
    // budget, because its deflection has not happened yet.
    for (let slot = 0; slot < TIME_TO_FLY_SLOT_COUNT; slot += 1) {
      if (exhausted || capped) return;
      const next = assigned.slice();
      next[event.planetIndex] = slot;
      search(event.craft, next, event.steps, event.approach, [...visited], planets[event.planetIndex].planetClass);
    }
  }

  search(launchState(), planets.map(() => null), 0, Number.POSITIVE_INFINITY, [], null);

  return { solutions, exhausted, capped, nodesUsed: nodes, bestApproach, bestAim, nearestMiss };
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
    // Cap 0: the first solution found proves the ablated level solvable, and
    // one is all this question needs.
    const result = verifyLevel(ablated, galaxy, nodeBudget, 0);
    // An exhausted ablation is not evidence of unsolvability, so fail closed.
    if (result.exhausted) return false;
    if (result.solutions.length > 0) return false;
  }
  return true;
}
