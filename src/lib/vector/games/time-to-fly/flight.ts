/**
 * Time to Fly — the flight itself. Pure, DOM-free, deterministic.
 *
 * The craft launches with a fixed velocity, coasts, is deflected by whichever
 * planet's field it is inside, and either reaches the galaxy, hits a planet,
 * leaves the arena, or runs out of time.
 *
 * ── This integrator IS the physics ───────────────────────────────────────────
 * It is not an approximation of Newtonian gravity that could be made "more
 * accurate" with a smaller step. The game's ground truth is exactly what
 * `stepCraft` computes at FIXED_TIMESTEP_MS, and the set of solutions to a
 * level is defined against it. That is deliberate: it means a solution found by
 * the verifier is bit-identical to the flight a player watches, which is the
 * only property that makes "this level has exactly two solutions" a statement
 * about the game rather than about a model of it.
 *
 * Consequently there is no analytic fast-forward anywhere, not even through
 * empty space. `p + k*v` and k successive `p += v` differ in IEEE-754, and a
 * verifier that took the shortcut would eventually certify a solution the
 * renderer cannot reproduce.
 *
 * Tunnelling is impossible by construction rather than by luck: the craft moves
 * at most LAUNCH_SPEED (4.2 px) per step, while the smallest lethal radius is a
 * small planet's body plus the ship, 23 px. A step can never skip a collision.
 */

import {
  TIME_TO_FLY_ARENA,
  TIME_TO_FLY_PHYSICS,
  type TimeToFlyVector,
} from "@/lib/vector/games/time-to-fly/constants";
import {
  type TimeToFlyArrangement,
  type TimeToFlyPlanet,
  planetClassOf,
  planetPositionAt,
} from "@/lib/vector/games/time-to-fly/orbit";

export type CraftState = Readonly<{
  position: TimeToFlyVector;
  velocity: TimeToFlyVector;
}>;

export type FlightOutcome =
  | "arrived"
  | "crashed"
  | "out-of-bounds"
  | "timeout";

export type FlightResult = Readonly<{
  outcome: FlightOutcome;
  steps: number;
  /** Closest the craft ever came to the galaxy centre. Drives the margin gate. */
  closestApproach: number;
  /** Which planet was struck, when the outcome is "crashed". */
  crashedInto: number | null;
  /** Final craft state, for the renderer's arrival/miss sequence. */
  craft: CraftState;
}>;

/** A planet resolved to a concrete position for one flight. */
export type PlacedPlanet = Readonly<{
  id: number;
  position: TimeToFlyVector;
  mass: number;
  bodyRadius: number;
  fieldRadius: number;
}>;

export function placePlanets(
  planets: readonly TimeToFlyPlanet[],
  arrangement: TimeToFlyArrangement,
): readonly PlacedPlanet[] {
  return planets.map((planet, index) => {
    const klass = planetClassOf(planet);
    return {
      id: planet.id,
      position: planetPositionAt(planet, arrangement[index] ?? 0),
      mass: klass.mass,
      bodyRadius: klass.bodyRadius,
      fieldRadius: klass.fieldRadius,
    };
  });
}

export function launchState(): CraftState {
  return {
    position: { x: TIME_TO_FLY_ARENA.LAUNCH_X, y: TIME_TO_FLY_ARENA.LAUNCH_Y },
    // Due east, identical in every level of every seed. The spec grants exactly
    // one pre-launch verb — dragging planets — so aiming is not a second
    // control surface, and a constant opening is the one thing a player can
    // learn by heart when there is no trajectory preview.
    velocity: { x: TIME_TO_FLY_PHYSICS.LAUNCH_SPEED, y: 0 },
  };
}

/**
 * Acceleration on the craft from every planet whose field contains it.
 *
 * Force has FINITE SUPPORT: exactly zero at and beyond fieldRadius, not merely
 * small. Between fields the craft therefore travels an exact straight line,
 * which is what makes each planet read as a discrete, legible gate rather than
 * as one term in a soup. With disjoint reach discs (see orbit.ts) at most one
 * term is ever non-zero, but the sum is written out because superposition is
 * the honest physics and the code should not depend on the packing invariant
 * to be correct.
 */
export function accelerationAt(
  position: TimeToFlyVector,
  planets: readonly PlacedPlanet[],
): TimeToFlyVector {
  const P = TIME_TO_FLY_PHYSICS;
  let ax = 0;
  let ay = 0;

  for (const planet of planets) {
    const dx = planet.position.x - position.x;
    const dy = planet.position.y - position.y;
    const distanceSquared = dx * dx + dy * dy;
    const fieldSquared = planet.fieldRadius * planet.fieldRadius;
    if (distanceSquared >= fieldSquared) continue;

    const distance = Math.sqrt(distanceSquared);
    if (distance === 0) continue;

    // u is distance as a fraction of the field radius, so the (1-u^2)^2 taper
    // reaches exactly zero at the rim — no discontinuity in force as the craft
    // crosses into or out of a field.
    const u = distance / planet.fieldRadius;
    const taper = 1 - u * u;
    const magnitude =
      (P.GRAVITY * planet.mass * taper * taper) / (u * u + P.SOFTENING * P.SOFTENING);

    ax += (dx / distance) * magnitude;
    ay += (dy / distance) * magnitude;
  }

  return { x: ax, y: ay };
}

/**
 * One fixed step, semi-implicit Euler: accelerate, then move with the updated
 * velocity. Symplectic, so a long coast does not gain or bleed energy the way
 * explicit Euler would, and it costs one force evaluation per step.
 */
export function stepCraft(craft: CraftState, planets: readonly PlacedPlanet[]): CraftState {
  const acceleration = accelerationAt(craft.position, planets);
  const vx = craft.velocity.x + acceleration.x;
  const vy = craft.velocity.y + acceleration.y;
  return {
    position: { x: craft.position.x + vx, y: craft.position.y + vy },
    velocity: { x: vx, y: vy },
  };
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

function distanceTo(a: TimeToFlyVector, b: TimeToFlyVector): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Fly until something ends the flight. Deterministic and total: every path
 * terminates, because the step budget is checked unconditionally.
 */
export function simulateFlight(
  planets: readonly PlacedPlanet[],
  galaxy: TimeToFlyVector,
): FlightResult {
  const P = TIME_TO_FLY_PHYSICS;
  let craft = launchState();
  let closestApproach = distanceTo(craft.position, galaxy);

  for (let step = 1; step <= P.MAX_FLIGHT_STEPS; step += 1) {
    craft = stepCraft(craft, planets);

    const toGalaxy = distanceTo(craft.position, galaxy);
    if (toGalaxy < closestApproach) closestApproach = toGalaxy;
    if (toGalaxy <= TIME_TO_FLY_ARENA.GALAXY_RADIUS) {
      return { outcome: "arrived", steps: step, closestApproach: toGalaxy, crashedInto: null, craft };
    }

    for (const planet of planets) {
      if (distanceTo(craft.position, planet.position) <= planet.bodyRadius + P.SHIP_RADIUS) {
        return { outcome: "crashed", steps: step, closestApproach, crashedInto: planet.id, craft };
      }
    }

    if (outOfBounds(craft.position)) {
      return { outcome: "out-of-bounds", steps: step, closestApproach, crashedInto: null, craft };
    }
  }

  return {
    outcome: "timeout",
    steps: P.MAX_FLIGHT_STEPS,
    closestApproach,
    crashedInto: null,
    craft,
  };
}

/** Convenience: fly a level's planets in a given arrangement. */
export function flyArrangement(
  planets: readonly TimeToFlyPlanet[],
  arrangement: TimeToFlyArrangement,
  galaxy: TimeToFlyVector,
): FlightResult {
  return simulateFlight(placePlanets(planets, arrangement), galaxy);
}
