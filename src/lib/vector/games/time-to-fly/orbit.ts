/**
 * Time to Fly — planets, their orbits, and the slot lattice. Pure, DOM-free.
 *
 * A planet never moves during a flight. The player's only pre-launch verb is to
 * drag a planet around its own fixed circular orbit, and the committed state of
 * that drag is a SLOT INDEX, not an angle. That choice is load-bearing twice
 * over:
 *
 *  - Determinism: slot -> position is a table lookup and two multiplications,
 *    so no transcendental ever runs (see constants.ts).
 *  - Provability: "how many valid solutions does this level have" becomes an
 *    exact integer question over a finite lattice, instead of a question about
 *    a continuous set that could only ever be sampled.
 *
 * The interaction still reads as continuous — the renderer follows the pointer
 * and eases to the nearest slot on release — but the state it commits is
 * discrete, so there is no tolerance band to get wrong and a retry is bit-exact.
 */

import {
  TIME_TO_FLY_PLANET_CLASSES,
  TIME_TO_FLY_SLOT_COUNT,
  TIME_TO_FLY_SLOT_UNITS,
  type TimeToFlyPlanetClass,
  type TimeToFlyVector,
} from "@/lib/vector/games/time-to-fly/constants";

export type TimeToFlyPlanet = Readonly<{
  /** Stable index within the level; also the planet's slot index in an arrangement. */
  id: number;
  planetClass: TimeToFlyPlanetClass;
  orbitCenter: TimeToFlyVector;
  orbitRadius: number;
}>;

/** One slot index per planet. This is the entire player-controlled state. */
export type TimeToFlyArrangement = readonly number[];

/**
 * Wrap a slot index into range. Dragging past the top of the orbit must come
 * back around rather than clamp, or a planet would develop invisible walls at
 * an arbitrary angle.
 */
export function normalizeSlot(slot: number): number {
  if (!Number.isFinite(slot)) return 0;
  const whole = Math.trunc(slot) % TIME_TO_FLY_SLOT_COUNT;
  return whole < 0 ? whole + TIME_TO_FLY_SLOT_COUNT : whole;
}

export function planetClassOf(planet: TimeToFlyPlanet) {
  return TIME_TO_FLY_PLANET_CLASSES[planet.planetClass];
}

/** Where a planet sits when its orbit is at `slot`. */
export function planetPositionAt(planet: TimeToFlyPlanet, slot: number): TimeToFlyVector {
  const unit = TIME_TO_FLY_SLOT_UNITS[normalizeSlot(slot)];
  return {
    x: planet.orbitCenter.x + planet.orbitRadius * unit.x,
    y: planet.orbitCenter.y + planet.orbitRadius * unit.y,
  };
}

/**
 * The disc containing every point this planet's gravity can ever touch, across
 * all slots. Because the planet is confined to its orbit, that is simply the
 * orbit radius plus the field radius.
 *
 * This is the quantity the whole design rests on: if two planets' reach discs
 * are disjoint, their fields can never overlap for ANY arrangement, so a flight
 * is a sequence of independent single-planet deflections. That is what gives
 * the player a gradient to reason along, and what collapses level verification
 * from an exponential search to a layered one. See ADR-0006.
 */
export function reachRadius(planet: TimeToFlyPlanet): number {
  return planet.orbitRadius + planetClassOf(planet).fieldRadius;
}

function distanceBetween(a: TimeToFlyVector, b: TimeToFlyVector): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  // Math.hypot is not required to be correctly rounded; sqrt is.
  return Math.sqrt(dx * dx + dy * dy);
}

/** Do two planets' fields stay separate no matter how the player arranges them? */
export function reachDiscsDisjoint(
  a: TimeToFlyPlanet,
  b: TimeToFlyPlanet,
  clearance = 0,
): boolean {
  return distanceBetween(a.orbitCenter, b.orbitCenter) >= reachRadius(a) + reachRadius(b) + clearance;
}

/** Is a fixed point (the launch pad, the galaxy) outside this planet's reach? */
export function pointOutsideReach(
  planet: TimeToFlyPlanet,
  point: TimeToFlyVector,
  clearance = 0,
): boolean {
  return distanceBetween(planet.orbitCenter, point) >= reachRadius(planet) + clearance;
}

/**
 * Every planet's field disjoint from every other's, for every arrangement.
 * Checked pairwise because the count is at most 5 planets — 10 pairs.
 */
export function allFieldsDisjoint(
  planets: readonly TimeToFlyPlanet[],
  clearance = 0,
): boolean {
  for (let i = 0; i < planets.length; i += 1) {
    for (let j = i + 1; j < planets.length; j += 1) {
      if (!reachDiscsDisjoint(planets[i], planets[j], clearance)) return false;
    }
  }
  return true;
}

/**
 * Straight-line reach test, used ONLY to prune dead branches during
 * verification — never to advance a flight.
 *
 * The distinction matters: advancing analytically (p + k*v) is not bit-identical
 * to k successive (p += v) in IEEE-754, so a solver that fast-forwards and a
 * renderer that steps would eventually disagree about where a craft went. A
 * "solution" the player cannot reproduce is worse than no solution. This
 * function answers only "could the ray ever come within R of this centre",
 * which is a conservative yes/no, and the flight itself is always stepped.
 */
export function rayReachesDisc(
  origin: TimeToFlyVector,
  direction: TimeToFlyVector,
  centre: TimeToFlyVector,
  radius: number,
): boolean {
  const toCentreX = centre.x - origin.x;
  const toCentreY = centre.y - origin.y;
  const speedSquared = direction.x * direction.x + direction.y * direction.y;
  if (speedSquared === 0) {
    return toCentreX * toCentreX + toCentreY * toCentreY <= radius * radius;
  }
  // Projection of the centre onto the ray, clamped to the forward half-line:
  // a disc behind the craft is not reachable.
  const along = (toCentreX * direction.x + toCentreY * direction.y) / speedSquared;
  const t = along < 0 ? 0 : along;
  const nearestX = origin.x + direction.x * t;
  const nearestY = origin.y + direction.y * t;
  const dx = centre.x - nearestX;
  const dy = centre.y - nearestY;
  return dx * dx + dy * dy <= radius * radius;
}
