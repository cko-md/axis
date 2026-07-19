/**
 * Time to Fly — level generation. Pure, DOM-free, deterministic.
 *
 * Levels are built CONSTRUCTIVELY, not sampled and hoped over: the generator
 * flies an intended winning trajectory and places each planet so that it
 * produces the turn that flight needs, then seats that planet on a legal orbit
 * with the intended slot. Solvability is therefore true by construction rather
 * than by luck.
 *
 * What construction cannot give is the ABSENCE of other solutions, so the
 * remaining two spec requirements — every planet materially necessary, and only
 * a small number of valid solutions — are not argued, they are counted, by the
 * exhaustive search in verify.ts. A candidate that fails any gate is discarded
 * and the seed is advanced deterministically.
 *
 * The hard constraint threaded through all of it is disjoint reach discs
 * (ADR-0006): no two planets' fields may overlap for ANY arrangement, because
 * that is what gives the player a solvable gradient. It is also the tightest
 * packing constraint in the game — two large planets need their orbit centres
 * 688 px apart — which is why level composition uses smaller classes as the
 * planet count rises.
 */

import {
  TIME_TO_FLY_ARENA,
  TIME_TO_FLY_LEVEL_COUNT,
  TIME_TO_FLY_PHYSICS,
  TIME_TO_FLY_PLANET_CLASSES,
  TIME_TO_FLY_SLOT_COUNT,
  TIME_TO_FLY_SLOT_UNITS,
  type TimeToFlyPlanetClass,
  type TimeToFlyVector,
} from "@/lib/vector/games/time-to-fly/constants";
import {
  type CraftState,
  flyArrangement,
  launchState,
  stepCraft,
} from "@/lib/vector/games/time-to-fly/flight";
import {
  type TimeToFlyArrangement,
  type TimeToFlyPlanet,
  allFieldsDisjoint,
  normalizeSlot,
  planetClassOf,
  pointOutsideReach,
  reachRadius,
} from "@/lib/vector/games/time-to-fly/orbit";
import { TIME_TO_FLY_NODE_BUDGET, everyPlanetNecessary, verifyLevel } from "@/lib/vector/games/time-to-fly/verify";

export type TimeToFlyLevel = Readonly<{
  index: number;
  seed: string;
  planets: readonly TimeToFlyPlanet[];
  galaxy: TimeToFlyVector;
  /** The seeded slots a level opens on, and returns to on an explicit reset. */
  initialArrangement: TimeToFlyArrangement;
  /** Exact count over the whole lattice — small by acceptance gate. */
  solutionCount: number;
}>;

export const TIME_TO_FLY_ACCEPTANCE = Object.freeze({
  /** "Only a small number of valid solutions per level", made an integer. */
  MIN_SOLUTIONS: 1,
  MAX_SOLUTIONS: 6,
  /** Clearance between reach discs, so fields are visibly separate, not merely disjoint. */
  DISC_CLEARANCE: 24,
  /**
   * A solution must be AIMED comfortably inside the galaxy, not scrape its rim
   * — otherwise the intended answer is not something a player can aim at.
   * Measured against verify's aim error (perpendicular miss distance of the
   * flight line at capture), never against the first sampled position inside
   * the capture disc: that position lands anywhere in [radius - speed, radius]
   * on step phase alone, and an earlier revision that gated on it rejected
   * ~93% of dead-centre solutions for a property the player cannot influence.
   */
  CLEAN_ARRIVAL: 0.85,
  /**
   * No losing branch may miss by a hair. A level decided inside this band is
   * decided by a margin the player cannot see and cannot learn from.
   */
  MISS_MARGIN: 1.2,
  MAX_ATTEMPTS: 400,
});

// FNV-1a then mulberry32 — the same deterministic pair Brickrise and Second
// Sense use. Byte-stable across engines forever, which a seeded level depends on.
function fnv1aHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Which planet classes a level uses.
 *
 * Larger planets steer harder but reach further, and reach is what consumes
 * arena. Level 1 gets a large planet so the very first thing a player meets has
 * obvious authority; later levels lean small so five disjoint fields still fit.
 */
const LEVEL_COMPOSITION = Object.freeze([
  Object.freeze<TimeToFlyPlanetClass[]>(["large"]),
  Object.freeze<TimeToFlyPlanetClass[]>(["medium", "large"]),
  Object.freeze<TimeToFlyPlanetClass[]>(["small", "medium", "small"]),
  Object.freeze<TimeToFlyPlanetClass[]>(["small", "medium", "small", "small"]),
  // One medium anchor, then smalls. Both extremes were measured and failed:
  // with the medium mid-chain its ~45-degree deep bend left a residual slope
  // the ~20-degree smalls could not unwind, and the chain tail walked through
  // the arena's top or bottom wall (60% of builds failed placement). All
  // smalls packed perfectly but could not force necessity — a skipped small
  // displaces the downstream entry by ~190 px, within the next disc's ~228 px
  // catch radius, so ablated levels stayed solvable and unthreaded arrivals
  // tripped the hair-miss gate. One early medium provides the unfakeable bend,
  // smalls keep the tail flat and packable.
  Object.freeze<TimeToFlyPlanetClass[]>(["small", "medium", "small", "small", "small"]),
]) as readonly (readonly TimeToFlyPlanetClass[])[];

/**
 * Rejection tally for the generator, exported so a test can report WHY a seed
 * failed rather than only that it did. Diagnostic; not read by gameplay.
 */
export const __rejectionTally: Record<string, number> = {};
function reject(reason: string): null {
  __rejectionTally[reason] = (__rejectionTally[reason] ?? 0) + 1;
  return null;
}

/**
 * A seeded starting arrangement that is NOT a solution, so the level opens
 * unsolved and stays reproducible across unlimited retries.
 */
function pickOpeningArrangement(
  planetCount: number,
  seed: string,
  solutionKeys: ReadonlySet<string>,
): readonly number[] | null {
  const random = mulberry32(fnv1aHash(`${seed}:opening`));
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const arrangement = Array.from({ length: planetCount }, () =>
      Math.floor(random() * TIME_TO_FLY_SLOT_COUNT) % TIME_TO_FLY_SLOT_COUNT,
    );
    if (!solutionKeys.has(arrangement.join(","))) return arrangement;
  }
  return null;
}

function perpendicular(velocity: TimeToFlyVector): TimeToFlyVector {
  const speed = Math.sqrt(velocity.x * velocity.x + velocity.y * velocity.y);
  if (speed === 0) return { x: 0, y: 0 };
  return { x: -velocity.y / speed, y: velocity.x / speed };
}

function unitOf(velocity: TimeToFlyVector): TimeToFlyVector {
  const speed = Math.sqrt(velocity.x * velocity.x + velocity.y * velocity.y);
  if (speed === 0) return { x: 1, y: 0 };
  return { x: velocity.x / speed, y: velocity.y / speed };
}

function insideArena(point: TimeToFlyVector, inset: number): boolean {
  return (
    point.x >= inset
    && point.y >= inset
    && point.x <= TIME_TO_FLY_ARENA.WIDTH - inset
    && point.y <= TIME_TO_FLY_ARENA.HEIGHT - inset
  );
}

/**
 * Generator tuning, separate from the acceptance gates: these shape what gets
 * BUILT, the gates decide what gets KEPT. Every value here trades attempt
 * count against level character, never correctness — the gates are the
 * correctness boundary.
 */
type GeneratorTuning = Readonly<{
  /**
   * Intended passes are drawn from the DEEP fraction of the survivable impact
   * band, nearest the planet. Two reasons. Deep passes deflect hard, so every
   * planet visibly earns its place. And deflection is steepest in impact there,
   * so moving the planet one slot changes the flight decisively — which is
   * what keeps the count of accidental alternative solutions near the intended
   * one, instead of a smear of neighbouring slots that all work.
   */
  deepImpactFraction: number;
  /** Vacuum approach run between the previous field and the next disc. */
  approachGapBase: number;
  approachGapJitter: number;
  /**
   * The pass-side choice steers the chain back toward the arena's vertical
   * middle once the projected pass centre drifts beyond this band. Without the
   * bias, accumulated deflections walk the chain into the arena wall and
   * four- and five-planet builds mostly fail to fit; with it, the chain
   * oscillates around the centreline. Inside the band the side stays random so
   * levels do not all share one shape. A WIDE band lets the chain snake, which
   * packs more path length into the same arena width — the lever the
   * five-planet level depends on.
   */
  recenterBand: number;
  /** How far past the last field the galaxy sits. Longer run-outs demand
   *  straighter aim, which is the cheapest lever against excess solutions. */
  runOutBase: number;
  runOutJitter: number;
  /** Probability of seating a planet on its class's larger orbit radius.
   *  Larger orbits sharpen slot sensitivity but consume more arena. */
  largeOrbitChance: number;
  /**
   * Buffer between the crash radius and the shallowest allowed intended
   * impact. Small margins put the intended pass close to its class's MAXIMUM
   * deflection, which is the strongest lever against alternative solutions:
   * a tour that needs to out-bend a near-maximal pass to re-aim simply
   * cannot, so whole families of compensating tours die. Safe for the player
   * because a committed slot replays bit-identically — depth is drama, not
   * execution risk. The walk still rejects any intended flight that
   * actually crashes.
   */
  minImpactMargin: number;
  /**
   * "alternate" forces consecutive passes onto opposite sides (a zigzag),
   * which sends wrong-side alternative bends away from the next disc where
   * the abandoned-planet rule kills them. "random" leaves the side to the
   * seed inside the recenter band.
   */
  sideMode: "random" | "alternate";
}>;

/**
 * Per-level generator tuning. One planet needs none of the tricks; five
 * planets need every inch of arena. Solution-count pressure also rises with
 * planet count — each extra planet multiplies the lattice — so later levels
 * draw deeper passes and longer run-outs to keep the count inside the gate.
 */
const GENERATOR_BY_LEVEL: readonly GeneratorTuning[] = Object.freeze([
  Object.freeze({ deepImpactFraction: 0.4, approachGapBase: 100, approachGapJitter: 160, recenterBand: 140, runOutBase: 260, runOutJitter: 220, largeOrbitChance: 0.5, minImpactMargin: 34, sideMode: "random" as const }),
  Object.freeze({ deepImpactFraction: 0.4, approachGapBase: 100, approachGapJitter: 160, recenterBand: 140, runOutBase: 260, runOutJitter: 220, largeOrbitChance: 0.5, minImpactMargin: 34, sideMode: "random" as const }),
  Object.freeze({ deepImpactFraction: 0.4, approachGapBase: 100, approachGapJitter: 160, recenterBand: 140, runOutBase: 260, runOutJitter: 220, largeOrbitChance: 0.5, minImpactMargin: 34, sideMode: "random" as const }),
  Object.freeze({ deepImpactFraction: 0.15, approachGapBase: 150, approachGapJitter: 160, recenterBand: 220, runOutBase: 420, runOutJitter: 200, largeOrbitChance: 0.5, minImpactMargin: 12, sideMode: "alternate" as const }),
  Object.freeze({ deepImpactFraction: 0.15, approachGapBase: 170, approachGapJitter: 160, recenterBand: 260, runOutBase: 420, runOutJitter: 200, largeOrbitChance: 1, minImpactMargin: 12, sideMode: "alternate" as const }),
]);

/**
 * Would a straight run from `origin` along unit `heading` cross any of
 * `planets`' reach discs within the next `limit` px? A prune predicate over
 * placements, never a state advance — the accepted geometry is always re-flown
 * with stepCraft.
 *
 * Receding discs (closest-approach parameter at or behind the origin) never
 * fail the test: the run starts on the rim of the disc the craft just exited,
 * and moving away from a disc cannot re-enter it.
 */
function runCrossesAnyDisc(
  origin: TimeToFlyVector,
  heading: TimeToFlyVector,
  limit: number,
  planets: readonly TimeToFlyPlanet[],
  clearance: number,
): boolean {
  for (const planet of planets) {
    const toCentreX = planet.orbitCenter.x - origin.x;
    const toCentreY = planet.orbitCenter.y - origin.y;
    const along = toCentreX * heading.x + toCentreY * heading.y;
    if (along <= 0) continue; // receding — cannot re-enter
    const t = along < limit ? along : limit;
    const nearestX = origin.x + heading.x * t;
    const nearestY = origin.y + heading.y * t;
    const dx = planet.orbitCenter.x - nearestX;
    const dy = planet.orbitCenter.y - nearestY;
    const radius = reachRadius(planet) + clearance;
    if (dx * dx + dy * dy < radius * radius) return true;
  }
  return false;
}

/**
 * Build one candidate level for a seed. Returns null when the geometry does not
 * close — a chain that wanders out of the arena, or planets whose fields would
 * overlap. The caller resamples.
 *
 * The intended flight is FLOWN, not assumed. An earlier revision placed each
 * planet a full reach-radius ahead of the craft and then tested "has the craft
 * left the disc" — which was true on the very first step, because the craft
 * started outside the disc it was supposed to fly through. The walk advanced
 * one step per planet, nothing was ever deflected, and every planet and the
 * galaxy were placed against an undeflected line the real flight leaves at the
 * first field. The walk below requires disc entry before disc exit, and field
 * entry at all, so the craft state each placement builds on is the state the
 * player's flight will actually be in.
 */
function buildCandidate(
  levelIndex: number,
  seed: string,
): Readonly<{ index: number; seed: string; planets: readonly TimeToFlyPlanet[]; galaxy: TimeToFlyVector; intended: TimeToFlyArrangement }> | null {
  const random = mulberry32(fnv1aHash(seed));
  const classes = LEVEL_COMPOSITION[levelIndex];
  const tuning = GENERATOR_BY_LEVEL[levelIndex];
  const planets: TimeToFlyPlanet[] = [];
  const intended: number[] = [];
  const arenaMiddle = TIME_TO_FLY_ARENA.HEIGHT / 2;
  let previousSide: -1 | 1 | null = null;

  let craft: CraftState = launchState();

  for (let index = 0; index < classes.length; index += 1) {
    const planetClass = classes[index];
    const klass = TIME_TO_FLY_PLANET_CLASSES[planetClass];

    // How far ahead along the current heading this planet sits, and how far
    // off-axis the craft will pass it. The impact parameter is kept inside the
    // survivable, monotone part of the deflection curve (see flight.test.ts) so
    // every intended pass is one the player could have reasoned about, and
    // drawn from the deep end of that band — see DEEP_IMPACT_FRACTION.
    const minImpact = klass.bodyRadius + TIME_TO_FLY_PHYSICS.SHIP_RADIUS + tuning.minImpactMargin;
    const impactBand = klass.fieldRadius - minImpact - 20;
    const impact = minImpact + random() * impactBand * tuning.deepImpactFraction;
    const orbitRadius = klass.orbitRadii[random() < tuning.largeOrbitChance ? 1 : 0];
    const slot = Math.floor(random() * TIME_TO_FLY_SLOT_COUNT) % TIME_TO_FLY_SLOT_COUNT;
    const unit = TIME_TO_FLY_SLOT_UNITS[slot];

    const heading = unitOf(craft.velocity);
    const normal = perpendicular(craft.velocity);
    const reach = reachRadius({ id: 0, planetClass, orbitCenter: { x: 0, y: 0 }, orbitRadius });
    const baseGap = reach + tuning.approachGapBase + random() * tuning.approachGapJitter;

    // Deflection turns the craft TOWARD the planet, so the pass side is also
    // the steering direction. Steer back toward the vertical middle when the
    // chain has drifted; otherwise leave it to the seed. For an eastbound
    // craft, normal.y * side has the sign of side, so side +1 turns down.
    const projectedY = craft.position.y + heading.y * (baseGap + 240);
    let side: -1 | 1;
    if (projectedY > arenaMiddle + tuning.recenterBand) side = -1;
    else if (projectedY < arenaMiddle - tuning.recenterBand) side = 1;
    else if (tuning.sideMode === "alternate" && previousSide !== null) side = previousSide === 1 ? -1 : 1;
    else side = random() < 0.5 ? -1 : 1;
    previousSide = side;

    // Push the planet further along the heading until its field clears every
    // field already placed. Disjointness is a hard invariant, and moving
    // outward is always available — so this is a deterministic repair rather
    // than a rejection, which is the difference between a generator that
    // converges and one that almost never does.
    let planet: TimeToFlyPlanet | null = null;
    for (let push = 0; push < 48; push += 1) {
      const gap = baseGap + push * 48;
      const centreOfPass = {
        x: craft.position.x + heading.x * gap,
        y: craft.position.y + heading.y * gap,
      };
      const planetPosition = {
        x: centreOfPass.x + normal.x * side * impact,
        y: centreOfPass.y + normal.y * side * impact,
      };
      const orbitCentre = {
        x: planetPosition.x - orbitRadius * unit.x,
        y: planetPosition.y - orbitRadius * unit.y,
      };
      const candidate: TimeToFlyPlanet = { id: index, planetClass, orbitCenter: orbitCentre, orbitRadius };

      // Once the disc has left the arena, pushing further only makes it worse.
      if (!insideArena(orbitCentre, reachRadius(candidate))) break;
      if (!pointOutsideReach(candidate, launchState().position, TIME_TO_FLY_ACCEPTANCE.DISC_CLEARANCE)) continue;
      if (!allFieldsDisjoint([...planets, candidate], TIME_TO_FLY_ACCEPTANCE.DISC_CLEARANCE)) continue;
      // The approach leg must be genuine vacuum: a straight run that threads
      // an EARLIER planet's disc on the way to this one would pick up real
      // deflection this placement never modelled.
      if (runCrossesAnyDisc(craft.position, heading, gap - reachRadius(candidate), planets, 0)) continue;
      planet = candidate;
      break;
    }
    if (!planet) return reject("no-disjoint-placement");

    planets.push(planet);
    intended.push(slot);

    // Fly the intended trajectory through this planet's field to get the entry
    // state for the next one. Stepped, never fast-forwarded, against every
    // planet placed so far — identical to the flight the player will fly,
    // because fields have finite support and later planets sit beyond the
    // walk's horizon.
    const placedSoFar = planets.map((p, i) => {
      const c = planetClassOf(p);
      const u = TIME_TO_FLY_SLOT_UNITS[intended[i]];
      return {
        id: p.id,
        position: { x: p.orbitCenter.x + p.orbitRadius * u.x, y: p.orbitCenter.y + p.orbitRadius * u.y },
        mass: c.mass,
        bodyRadius: c.bodyRadius,
        fieldRadius: c.fieldRadius,
      };
    });

    let stepped = 0;
    const discRadius = reachRadius(planet);
    let enteredDisc = false;
    let enteredField = false;
    let leftDisc = false;
    while (stepped < TIME_TO_FLY_PHYSICS.MAX_FLIGHT_STEPS) {
      craft = stepCraft(craft, placedSoFar);
      stepped += 1;
      // Crashing into any placed body means this geometry is not a solution.
      for (const placed of placedSoFar) {
        const bodyDx = craft.position.x - placed.position.x;
        const bodyDy = craft.position.y - placed.position.y;
        if (Math.sqrt(bodyDx * bodyDx + bodyDy * bodyDy) <= placed.bodyRadius + TIME_TO_FLY_PHYSICS.SHIP_RADIUS) {
          return reject("intended-flight-crashes");
        }
      }
      if (!insideArena(craft.position, 0)) return reject("intended-flight-leaves-arena");

      const dx = craft.position.x - planet.orbitCenter.x;
      const dy = craft.position.y - planet.orbitCenter.y;
      const fromCentre = Math.sqrt(dx * dx + dy * dy);
      const bodyDx = craft.position.x - placedSoFar[index].position.x;
      const bodyDy = craft.position.y - placedSoFar[index].position.y;
      if (Math.sqrt(bodyDx * bodyDx + bodyDy * bodyDy) < klass.fieldRadius) enteredField = true;

      // The leg ends when the craft has been INSIDE this planet's reach disc
      // and then left it. Exit-without-entry is not a pass, it is a placement
      // error, and treating it as an exit is exactly the bug this walk fixes.
      if (fromCentre <= discRadius) enteredDisc = true;
      else if (enteredDisc) {
        leftDisc = true;
        break;
      }
    }
    if (!leftDisc) return reject("never-exits-disc");
    // A pass that traversed the disc but never the field was not deflected —
    // the threading rule would reject the flight, so reject the placement.
    if (!enteredField) return reject("intended-pass-misses-field");
  }

  // The galaxy sits on the trajectory the intended solution leaves behind,
  // pushed out until it is clear of every field — a target inside a gravity
  // well would be reachable by accident from directions the design never
  // intended. The whole run-out segment must clear every disc, not merely the
  // endpoint: a galaxy placed beyond an intervening field is a lie, because
  // the intended flight would be bent again before reaching it.
  const exitHeading = unitOf(craft.velocity);
  const baseRunOut = tuning.runOutBase + random() * tuning.runOutJitter;
  let galaxy: TimeToFlyVector | null = null;
  for (let push = 0; push < 60; push += 1) {
    const runOut = baseRunOut + push * 40;
    const point = {
      x: craft.position.x + exitHeading.x * runOut,
      y: craft.position.y + exitHeading.y * runOut,
    };
    if (!insideArena(point, TIME_TO_FLY_ARENA.GALAXY_RADIUS + 40)) break;
    if (!planets.every((planet) => pointOutsideReach(planet, point, TIME_TO_FLY_ACCEPTANCE.DISC_CLEARANCE))) continue;
    if (runCrossesAnyDisc(craft.position, exitHeading, runOut, planets, TIME_TO_FLY_ACCEPTANCE.DISC_CLEARANCE)) continue;
    galaxy = point;
    break;
  }
  if (!galaxy) return reject("no-clear-galaxy-site");

  return { index: levelIndex, seed, planets, galaxy, intended };
}

/** Exposed for diagnostics only: build one candidate without acceptance gates. */
export function __buildCandidateForTest(levelIndex: number, seed: string) {
  return buildCandidate(levelIndex, seed);
}

/**
 * Generate the level at `levelIndex` for a run seed.
 *
 * Deterministic and total: the same run seed always produces the same five
 * levels, and generation either returns an accepted level or throws — it never
 * returns one that failed a gate. Throwing is the honest failure: a level that
 * cannot be verified must not reach a player.
 */
export function generateTimeToFlyLevel(runSeed: string, levelIndex: number): TimeToFlyLevel {
  if (!Number.isInteger(levelIndex) || levelIndex < 0 || levelIndex >= TIME_TO_FLY_LEVEL_COUNT) {
    throw new Error(`TIME_TO_FLY_LEVEL_INDEX_OUT_OF_RANGE: ${levelIndex}`);
  }

  for (let attempt = 0; attempt < TIME_TO_FLY_ACCEPTANCE.MAX_ATTEMPTS; attempt += 1) {
    const seed = `${runSeed}:${levelIndex}:${attempt}`;
    const candidate = buildCandidate(levelIndex, seed);
    if (!candidate) continue;

    // Cheap gates first — each costs a handful of full flights, versus the
    // branching search below.
    //
    // The intended arrangement must actually win when flown as the player
    // flies it: all planets placed, launch to capture. The constructive walk
    // makes this true by design, so a failure here means the walk and the
    // real flight have diverged — the exact defect this generator once had —
    // and the candidate cannot be trusted.
    const intendedFlight = flyArrangement(candidate.planets, candidate.intended, candidate.galaxy);
    if (intendedFlight.outcome !== "arrived") { reject("intended-not-a-solution"); continue; }

    // Decisiveness: nudging any single planet one slot off the intended
    // arrangement must lose. A candidate where a neighbouring slot also wins
    // is on its way to a smear of near-duplicate solutions — cheaper to
    // reject on 2N flights here than to enumerate them all below.
    let insensitive = false;
    for (let planetIndex = 0; planetIndex < candidate.planets.length && !insensitive; planetIndex += 1) {
      for (const delta of [-1, 1]) {
        const nudged = candidate.intended.slice();
        nudged[planetIndex] = normalizeSlot(nudged[planetIndex] + delta);
        if (flyArrangement(candidate.planets, nudged, candidate.galaxy).outcome === "arrived") {
          insensitive = true;
          break;
        }
      }
    }
    if (insensitive) { reject("slot-insensitive"); continue; }

    const verdict = verifyLevel(
      candidate.planets,
      candidate.galaxy,
      TIME_TO_FLY_NODE_BUDGET,
      TIME_TO_FLY_ACCEPTANCE.MAX_SOLUTIONS,
    );
    // Fail closed: an exhausted search proves nothing about the solution count.
    if (verdict.exhausted) { reject("search-exhausted"); continue; }
    if (verdict.capped || verdict.solutions.length > TIME_TO_FLY_ACCEPTANCE.MAX_SOLUTIONS) { reject("too-many-solutions"); continue; }
    if (verdict.solutions.length < TIME_TO_FLY_ACCEPTANCE.MIN_SOLUTIONS) { reject("unsolvable"); continue; }

    // The level must NOT open already solved. The constructed arrangement is
    // scaffolding for placing planets, not the answer — requiring it to be a
    // solution was both fragile and wrong, since a level whose starting
    // position wins on the first launch is not a puzzle. The verifier owns the
    // solution set; the opening arrangement is a seeded position outside it.
    const solutionKeys = new Set(verdict.solutions.map((arrangement) => arrangement.join(",")));
    const opening = pickOpeningArrangement(candidate.planets.length, seed, solutionKeys);
    if (!opening) { reject("no-unsolved-opening"); continue; }

    if (verdict.bestAim > TIME_TO_FLY_ARENA.GALAXY_RADIUS * TIME_TO_FLY_ACCEPTANCE.CLEAN_ARRIVAL) { reject("no-clean-arrival"); continue; }
    if (verdict.nearestMiss < TIME_TO_FLY_ARENA.GALAXY_RADIUS * TIME_TO_FLY_ACCEPTANCE.MISS_MARGIN) { reject("hair-miss"); continue; }

    if (!everyPlanetNecessary(candidate.planets, candidate.galaxy)) { reject("planet-not-necessary"); continue; }

    return {
      index: candidate.index,
      seed: candidate.seed,
      planets: candidate.planets,
      galaxy: candidate.galaxy,
      initialArrangement: opening,
      solutionCount: verdict.solutions.length,
    };
  }

  throw new Error(`TIME_TO_FLY_LEVEL_GENERATION_FAILED: ${runSeed}:${levelIndex}`);
}

/** All five levels for a run seed. */
export function generateTimeToFlyRun(runSeed: string): readonly TimeToFlyLevel[] {
  return Array.from({ length: TIME_TO_FLY_LEVEL_COUNT }, (_, index) =>
    generateTimeToFlyLevel(runSeed, index),
  );
}
