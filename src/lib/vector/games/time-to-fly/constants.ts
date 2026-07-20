/**
 * Time to Fly — tuning constants and the slot lattice (Wave 15.9).
 *
 * Pure data. Every number a flight depends on lives here so that a later
 * engine or renderer change cannot quietly alter what is solvable.
 *
 * ── Determinism rule, and why it is strict ───────────────────────────────────
 * Nothing on the generation or simulation path may call a transcendental.
 * Math.cos/sin/atan2/hypot are NOT required by ECMAScript to be correctly
 * rounded, so two engines may disagree in the last ulp — and a level whose
 * solution set is decided by an exhaustive search over trajectories can flip
 * from "one solution" to "two" on that difference. Only +, -, *, / and
 * Math.sqrt (all correctly rounded by spec) are permitted.
 *
 * That is why planet placement is a LATTICE rather than a continuous angle:
 * the unit vector for every slot is a hardcoded literal below, so positioning a
 * planet is multiplication, never trigonometry. The table was generated once by
 * quadrant mirroring (so it is exactly 4-fold symmetric) and is checked against
 * Math.cos/Math.sin in flight.test.ts's "slot lattice" block — verified
 * correct, never computed.
 */

/** Slots a planet can occupy on its orbit. 12 slots = 30 degrees apart. */
export const TIME_TO_FLY_SLOT_COUNT = 12;

/**
 * Unit vectors for each slot, counter-clockwise from due east.
 * Hardcoded on purpose — see the determinism rule above.
 */
export type TimeToFlyVector = Readonly<{ x: number; y: number }>;

export const TIME_TO_FLY_SLOT_UNITS: readonly TimeToFlyVector[] = Object.freeze<TimeToFlyVector[]>([
  { x: 1, y: 0 },
  { x: 0.8660254037844387, y: 0.49999999999999994 },
  { x: 0.5000000000000001, y: 0.8660254037844386 },
  { x: 0, y: 1 },
  { x: -0.49999999999999994, y: 0.8660254037844387 },
  { x: -0.8660254037844386, y: 0.5000000000000001 },
  { x: -1, y: 0 },
  { x: -0.8660254037844387, y: -0.49999999999999994 },
  { x: -0.5000000000000001, y: -0.8660254037844386 },
  { x: 0, y: -1 },
  { x: 0.49999999999999994, y: -0.8660254037844387 },
  { x: 0.8660254037844386, y: -0.5000000000000001 },
]);

export const TIME_TO_FLY_PHYSICS = Object.freeze({
  /** Simulation step. Units below are px/step and px/step^2, never wall-clock. */
  FIXED_TIMESTEP_MS: 1000 / 60,
  /**
   * Field strength scalar; acceleration also scales with planet mass.
   *
   * Tuned to the strongest value at which deflection is still MONOTONE in
   * impact parameter across every planet class (flight.test.ts asserts this).
   * At 0.014 and above the curve grows a second lobe — a craft passing at 120 px
   * is deflected as hard as one passing at 60 px — so two visibly different
   * approaches produce the same turn. With no trajectory preview that
   * ambiguity is unreadable, and the player has nothing to reason from.
   *
   * 0.01 keeps ~44 degrees of steering authority from a large planet while the
   * relationship stays "closer means more turn, always".
   */
  GRAVITY: 0.01,
  /**
   * Softening, as a fraction of a planet's field radius. Without it the
   * acceleration diverges as the craft approaches a planet centre and the
   * integrator loses all meaning. The craft dies on body contact well before
   * this matters, so softening shapes the near field rather than hiding a
   * singularity the player can reach.
   */
  SOFTENING: 0.18,
  LAUNCH_SPEED: 4.2,
  SHIP_RADIUS: 5,
  /** A flight that has not resolved by here is a miss. 30 seconds at 60 Hz. */
  MAX_FLIGHT_STEPS: 1800,
});

export const TIME_TO_FLY_ARENA = Object.freeze({
  /**
   * Sized by the five-planet level, measured rather than hoped: five disjoint
   * reach discs (ADR-0006) plus the leg lengths that keep the solution count
   * inside the acceptance gate use up to ~4500 px of eastward run. At 3400 px
   * wide the level-5 generator converged on zero of six seeds — short legs
   * widen the angular window each planet's field subtends, and the solution
   * count explodes into the hundreds. The camera is a shell concern; the
   * arena is whatever the puzzle needs.
   */
  WIDTH: 4600,
  HEIGHT: 1900,
  /** How far outside the arena a craft may drift before the flight is a miss. */
  OUT_OF_BOUNDS_MARGIN: 240,
  LAUNCH_X: 170,
  LAUNCH_Y: 950,
  GALAXY_RADIUS: 26,
});

/**
 * The three planet classes, identical in every level — the binding spec
 * requires appearance, size and gravity to stay consistent across levels, so a
 * player's understanding of a large planet transfers from level 1 to level 5.
 *
 * fieldRadius grows with mass, which is the spec's "larger planets exert
 * stronger force across a larger field": bigger planets are not merely
 * stronger at a given distance, they reach further.
 */
export const TIME_TO_FLY_PLANET_CLASSES = Object.freeze({
  small: Object.freeze({ bodyRadius: 18, mass: 1, fieldRadius: 132, orbitRadii: Object.freeze([72, 96]) }),
  medium: Object.freeze({ bodyRadius: 26, mass: 1.8, fieldRadius: 176, orbitRadii: Object.freeze([84, 108]) }),
  large: Object.freeze({ bodyRadius: 34, mass: 3, fieldRadius: 220, orbitRadii: Object.freeze([96, 124]) }),
});

export type TimeToFlyPlanetClass = keyof typeof TIME_TO_FLY_PLANET_CLASSES;

/** The shape of a class entry, widened from the frozen literal types. */
export type TimeToFlyPlanetClassSpec = Readonly<{
  bodyRadius: number;
  mass: number;
  fieldRadius: number;
  orbitRadii: readonly number[];
}>;

export const TIME_TO_FLY_LEVEL_COUNT = 5;
