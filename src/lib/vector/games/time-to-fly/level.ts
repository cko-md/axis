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
  launchState,
  stepCraft,
} from "@/lib/vector/games/time-to-fly/flight";
import {
  type TimeToFlyArrangement,
  type TimeToFlyPlanet,
  allFieldsDisjoint,
  planetClassOf,
  pointOutsideReach,
  reachRadius,
} from "@/lib/vector/games/time-to-fly/orbit";
import { everyPlanetNecessary, verifyLevel } from "@/lib/vector/games/time-to-fly/verify";

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
  MAX_SOLUTIONS: 3,
  /** Clearance between reach discs, so fields are visibly separate, not merely disjoint. */
  DISC_CLEARANCE: 24,
  /**
   * A solution must arrive comfortably inside the galaxy, not scrape its rim —
   * otherwise the intended answer is not something a player can aim at.
   */
  CLEAN_ARRIVAL: 0.6,
  /**
   * No losing branch may miss by a hair. A level decided inside this band is
   * decided by a margin the player cannot see and cannot learn from.
   */
  MISS_MARGIN: 1.35,
  MAX_ATTEMPTS: 240,
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
  Object.freeze<TimeToFlyPlanetClass[]>(["small", "small", "medium", "small", "small"]),
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
 * Build one candidate level for a seed. Returns null when the geometry does not
 * close — a chain that wanders out of the arena, or planets whose fields would
 * overlap. The caller resamples.
 */
function buildCandidate(levelIndex: number, seed: string): Omit<TimeToFlyLevel, "solutionCount"> | null {
  const random = mulberry32(fnv1aHash(seed));
  const classes = LEVEL_COMPOSITION[levelIndex];
  const planets: TimeToFlyPlanet[] = [];
  const intended: number[] = [];

  let craft: CraftState = launchState();

  for (let index = 0; index < classes.length; index += 1) {
    const planetClass = classes[index];
    const klass = TIME_TO_FLY_PLANET_CLASSES[planetClass];

    // How far ahead along the current heading this planet sits, and how far
    // off-axis the craft will pass it. The impact parameter is kept inside the
    // survivable, monotone part of the deflection curve (see flight.test.ts) so
    // every intended pass is one the player could have reasoned about.
    const minImpact = klass.bodyRadius + TIME_TO_FLY_PHYSICS.SHIP_RADIUS + 34;
    const impact = minImpact + random() * (klass.fieldRadius - minImpact - 20);
    const side = random() < 0.5 ? -1 : 1;
    const orbitRadius = klass.orbitRadii[random() < 0.5 ? 0 : 1];
    const slot = Math.floor(random() * TIME_TO_FLY_SLOT_COUNT) % TIME_TO_FLY_SLOT_COUNT;
    const unit = TIME_TO_FLY_SLOT_UNITS[slot];

    const heading = unitOf(craft.velocity);
    const normal = perpendicular(craft.velocity);
    const baseGap =
      reachRadius({ id: 0, planetClass, orbitCenter: { x: 0, y: 0 }, orbitRadius })
      + 120 + random() * 180;

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
      planet = candidate;
      break;
    }
    if (!planet) return reject("no-disjoint-placement");

    planets.push(planet);
    intended.push(slot);

    // Fly the intended trajectory through this planet to get the entry state
    // for the next one. Stepped, never fast-forwarded.
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
    const exitRadius = reachRadius(planet);
    let leftDisc = false;
    while (stepped < TIME_TO_FLY_PHYSICS.MAX_FLIGHT_STEPS) {
      craft = stepCraft(craft, placedSoFar);
      stepped += 1;
      const dx = craft.position.x - planet.orbitCenter.x;
      const dy = craft.position.y - planet.orbitCenter.y;
      const fromCentre = Math.sqrt(dx * dx + dy * dy);
      // Crashing into the planet we are building around means this geometry is
      // not a solution at all.
      const bodyDx = craft.position.x - placedSoFar[index].position.x;
      const bodyDy = craft.position.y - placedSoFar[index].position.y;
      if (Math.sqrt(bodyDx * bodyDx + bodyDy * bodyDy) <= klass.bodyRadius + TIME_TO_FLY_PHYSICS.SHIP_RADIUS) {
        return reject("intended-flight-crashes");
      }
      if (!insideArena(craft.position, 0)) return reject("intended-flight-leaves-arena");
      if (fromCentre > exitRadius) {
        leftDisc = true;
        break;
      }
    }
    if (!leftDisc) return reject("never-exits-disc");
  }

  // The galaxy sits on the trajectory the intended solution leaves behind.
  // The galaxy sits on the trajectory the intended solution leaves behind,
  // pushed out until it is clear of every field — a target inside a gravity
  // well would be reachable by accident from directions the design never
  // intended.
  const exitHeading = unitOf(craft.velocity);
  const baseRunOut = 200 + random() * 200;
  let galaxy: TimeToFlyVector | null = null;
  for (let push = 0; push < 60; push += 1) {
    const runOut = baseRunOut + push * 40;
    const point = {
      x: craft.position.x + exitHeading.x * runOut,
      y: craft.position.y + exitHeading.y * runOut,
    };
    if (!insideArena(point, TIME_TO_FLY_ARENA.GALAXY_RADIUS + 40)) break;
    if (planets.every((planet) => pointOutsideReach(planet, point, TIME_TO_FLY_ACCEPTANCE.DISC_CLEARANCE))) {
      galaxy = point;
      break;
    }
  }
  if (!galaxy) return reject("no-clear-galaxy-site");

  return { index: levelIndex, seed, planets, galaxy, initialArrangement: intended };
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

    const verdict = verifyLevel(candidate.planets, candidate.galaxy);
    // Fail closed: an exhausted search proves nothing about the solution count.
    if (verdict.exhausted) { reject("search-exhausted"); continue; }
    if (verdict.solutions.length < TIME_TO_FLY_ACCEPTANCE.MIN_SOLUTIONS) { reject("unsolvable"); continue; }
    if (verdict.solutions.length > TIME_TO_FLY_ACCEPTANCE.MAX_SOLUTIONS) { reject("too-many-solutions"); continue; }

    // The intended arrangement must be among them, or the level is solvable
    // only by some route the generator did not design and cannot vouch for.
    const intendedKey = candidate.initialArrangement.join(",");
    if (!verdict.solutions.some((arrangement) => arrangement.join(",") === intendedKey)) { reject("intended-not-a-solution"); continue; }

    if (verdict.bestApproach > TIME_TO_FLY_ARENA.GALAXY_RADIUS * TIME_TO_FLY_ACCEPTANCE.CLEAN_ARRIVAL) { reject("no-clean-arrival"); continue; }
    if (verdict.nearestMiss < TIME_TO_FLY_ARENA.GALAXY_RADIUS * TIME_TO_FLY_ACCEPTANCE.MISS_MARGIN) { reject("hair-miss"); continue; }

    if (!everyPlanetNecessary(candidate.planets, candidate.galaxy)) { reject("planet-not-necessary"); continue; }

    return { ...candidate, solutionCount: verdict.solutions.length };
  }

  throw new Error(`TIME_TO_FLY_LEVEL_GENERATION_FAILED: ${runSeed}:${levelIndex}`);
}

/** All five levels for a run seed. */
export function generateTimeToFlyRun(runSeed: string): readonly TimeToFlyLevel[] {
  return Array.from({ length: TIME_TO_FLY_LEVEL_COUNT }, (_, index) =>
    generateTimeToFlyLevel(runSeed, index),
  );
}
