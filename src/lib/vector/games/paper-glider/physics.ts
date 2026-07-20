/**
 * Paper Glider flight — pure, deterministic, DOM-free.
 *
 * The binding spec calls for "continuous 3D flight guided by pointer or
 * touch" with "forgiving arcade movement". This module is the whole of what
 * that means as numbers: a forward speed curve driven purely by distance
 * flown, and a lateral/vertical "seek" controller with a bounded turning
 * authority — bounded acceleration, bounded top speed — so a jittery pointer
 * never produces a jittery glider.
 *
 * Every quantity here is PER FIXED STEP, never per wall-clock second, exactly
 * like Brickrise's `physics.ts`. `z` only ever advances by calling
 * `stepGlider`, so replaying the same sequence of targets against the same
 * starting state always reproduces the same flight, which is what makes the
 * room generator's passability bound (see `level.ts`) provable rather than
 * asserted.
 */

/** Room-local flight state. x is lateral, y is vertical, z is forward distance flown since the run began. */
export type GliderState = Readonly<{
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
}>;

/**
 * Where the player wants the glider, in the same room-local (x, y) space as
 * `GliderState`. Produced by the shell from a raw pointer/touch position —
 * that mapping (screen space -> room space, dead zones, clamping) is input
 * normalization and is deliberately NOT this module's concern; it belongs to
 * the shell wave.
 */
export type SteerTarget = Readonly<{ x: number; y: number }>;

export const PAPER_GLIDER_PHYSICS = Object.freeze({
  FIXED_TIMESTEP_MS: 1000 / 60,

  /** Forward speed at the very start of a run, in world units per fixed step. */
  SPEED_BASE: 0.5,
  /**
   * How much forward speed is added per world unit of distance flown. Chosen
   * so the curve reaches SPEED_CAP at z = 600 (see the derived
   * `distanceToSpeedCap` relation exercised in physics.test.ts) — roughly 15
   * rooms in, well inside the 30-room window the passability oracle covers,
   * so that corpus genuinely exercises capped-speed generation rather than
   * only the easier ramp-up phase.
   */
  SPEED_GROWTH_PER_UNIT: 0.0015,
  /**
   * Forward speed ceiling. This is the OTHER half of the constants relation
   * the 15.8 lesson demands: raising this number does not, by itself, risk an
   * impossible room, because `maxSteerableRadius` below is re-derived from
   * whatever this value is at generation time — there is no second,
   * independently-tuned "how far can a room's opening drift" constant to fall
   * out of sync with it. See `level.test.ts` for the regression test that
   * would fail first if that relationship were ever broken by hand-editing
   * only one side of it.
   */
  SPEED_CAP: 1.4,

  /** Maximum combined lateral+vertical velocity magnitude the glider can hold. */
  STEER_MAX_SPEED: 0.6,
  /**
   * Maximum change in the (vx, vy) velocity VECTOR per step — a bounded
   * turning acceleration, not a per-axis one. Clamping the vector rather than
   * each axis independently keeps the controller rotationally symmetric: the
   * glider can turn exactly as hard toward a diagonal target as toward an
   * axis-aligned one. That symmetry is what lets `maxSteerableRadius` measure
   * a single reachable RADIUS using one axis-aligned probe and have it apply
   * to a drift in any direction.
   */
  STEER_ACCEL: 0.05,

  /**
   * Collision hull radius. Deliberately smaller than the glider's visual
   * model (a rendering decision for the shell wave, not this module) so a
   * near miss reads as a near miss rather than a clip — "forgiving arcade
   * movement" applies to collision, not just steering.
   */
  HULL_RADIUS: 0.35,
});

export const INITIAL_GLIDER_STATE: GliderState = Object.freeze({ x: 0, y: 0, z: 0, vx: 0, vy: 0 });

/**
 * How close (in world units) to a steering target the glider must be before
 * it starts easing off STEER_MAX_SPEED, rather than flying at full speed
 * until it passes the target and only then reversing.
 *
 * DERIVED, not hand-picked: it is exactly the distance a body already moving
 * at STEER_MAX_SPEED needs to decelerate to a stop at a constant rate of
 * STEER_ACCEL per step (basic kinematics, d = v^2 / (2a)). Without this — a
 * naive "seek" toward a fixed nearby target with no other damping in the
 * system — the glider overshoots, reverses, overshoots again, and settles
 * into a sustained oscillation around the target rather than arriving at it.
 * That oscillation would occasionally carry it wider than a doorway's own
 * half-width right at the moment it needs to be centred in one, so this is
 * not cosmetic: it is part of what keeps the passability bound in level.ts
 * honest.
 */
export const STEER_ARRIVE_RADIUS = PAPER_GLIDER_PHYSICS.STEER_MAX_SPEED ** 2 / (2 * PAPER_GLIDER_PHYSICS.STEER_ACCEL);

/** Forward speed at a given distance flown. Monotonically non-decreasing, capped. */
export function speedAtDistance(z: number): number {
  const P = PAPER_GLIDER_PHYSICS;
  const distance = Number.isFinite(z) ? Math.max(0, z) : 0;
  return Math.min(P.SPEED_CAP, P.SPEED_BASE + P.SPEED_GROWTH_PER_UNIT * distance);
}

/** Distance flown at which the speed curve reaches SPEED_CAP. */
export function distanceToSpeedCap(): number {
  const P = PAPER_GLIDER_PHYSICS;
  return (P.SPEED_CAP - P.SPEED_BASE) / P.SPEED_GROWTH_PER_UNIT;
}

/**
 * Move a velocity vector toward a desired velocity vector, bounded by
 * `maxDelta` in COMBINED magnitude (see STEER_ACCEL above). This is the only
 * place turning authority is enforced, so the seek controller cannot
 * accidentally grant more turning power on one axis than the other.
 */
export function steerVelocityToward(
  vx: number,
  vy: number,
  desiredVx: number,
  desiredVy: number,
  maxDelta: number,
): Readonly<{ vx: number; vy: number }> {
  const dvx = desiredVx - vx;
  const dvy = desiredVy - vy;
  const magnitude = Math.hypot(dvx, dvy);
  if (magnitude <= maxDelta) return { vx: desiredVx, vy: desiredVy };
  const scale = maxDelta / magnitude;
  return { vx: vx + dvx * scale, vy: vy + dvy * scale };
}

/**
 * Advance one fixed step. Pure: the same state and target always produce the
 * same next state, which is what makes a recorded flight replayable and the
 * generator's reachability math trustworthy.
 *
 * Steering is a bounded-acceleration "arrive": velocity chases the unit
 * vector toward `target`, scaled to STEER_MAX_SPEED outside
 * STEER_ARRIVE_RADIUS and eased down linearly within it, with the velocity
 * change itself bounded by STEER_ACCEL per step. The easing (rather than a
 * flat "seek" to full speed) is what keeps a pursuit of a nearby, reachable
 * target from overshooting and oscillating — see STEER_ARRIVE_RADIUS's own
 * comment. Forward motion is decoupled — the glider always advances along z
 * at `speedAtDistance(z)` regardless of how hard it is steering, which is
 * what "forgiving" means here: a player who oversteers loses no forward
 * progress, only time spent off-centre.
 */
export function stepGlider(state: GliderState, target: SteerTarget): GliderState {
  const P = PAPER_GLIDER_PHYSICS;
  const dx = target.x - state.x;
  const dy = target.y - state.y;
  const distance = Math.hypot(dx, dy);
  const desiredSpeed =
    distance < STEER_ARRIVE_RADIUS ? (distance / STEER_ARRIVE_RADIUS) * P.STEER_MAX_SPEED : P.STEER_MAX_SPEED;
  const desiredVx = distance > 0 ? (dx / distance) * desiredSpeed : 0;
  const desiredVy = distance > 0 ? (dy / distance) * desiredSpeed : 0;
  const { vx, vy } = steerVelocityToward(state.vx, state.vy, desiredVx, desiredVy, P.STEER_ACCEL);
  const speed = speedAtDistance(state.z);

  return {
    x: state.x + vx,
    y: state.y + vy,
    z: state.z + speed,
    vx,
    vy,
  };
}

/**
 * The passability bound: how far the REAL step function can carry the
 * glider laterally over `depth` forward units, starting from rest at forward
 * distance `startZ`, steering maximally in one direction the whole time.
 *
 * This is Paper Glider's equivalent of Brickrise's `peakRise` — the fix for
 * exactly the defect class the 15.8 handoff calls out: "two independently
 * tuned constants with nothing relating them". `level.ts` calls this at
 * generation time (not a value copied from a comment) to decide how far the
 * next room's opening is allowed to drift, so the speed curve and the room
 * generator can never silently fall out of agreement the way JUMP_IMPULSE and
 * FLOOR_SPACING once did.
 *
 * A single axis-aligned probe (target far along +x, y held at the start
 * value) is sufficient for ANY direction because `steerVelocityToward` clamps
 * the acceleration VECTOR's magnitude, not each axis independently — the
 * controller is rotationally symmetric, so the reachable set after `depth`
 * units of forward flight is a disc of this radius, not direction-dependent.
 */
export function maxSteerableRadius(startZ: number, depth: number): number {
  if (!Number.isFinite(depth) || depth <= 0) return 0;

  const FAR = 1_000_000;
  const targetZ = Math.max(0, startZ) + depth;
  let state: GliderState = { x: 0, y: 0, z: Math.max(0, startZ), vx: 0, vy: 0 };
  const target: SteerTarget = { x: FAR, y: 0 };

  // Forward speed is always strictly positive (SPEED_BASE > 0), so this loop
  // always terminates in a bounded number of steps; the guard only protects
  // against a future misconfiguration that zeroes it out.
  let guard = 0;
  const GUARD_LIMIT = 200_000;
  while (state.z < targetZ && guard < GUARD_LIMIT) {
    state = stepGlider(state, target);
    guard += 1;
  }

  return Math.abs(state.x);
}

/** One sampled point of a simulated flight path. */
export type GliderPathSample = Readonly<{ x: number; y: number; z: number }>;

/**
 * Simulate the trajectory a glider actually takes flying from `entry` to
 * `exit`, starting at rest at the entry position and pursuing the exit for
 * the whole distance — the same "arrive" dynamics `stepGlider` always uses.
 * Returned as one (x, y, z) sample per fixed step, ascending in z.
 *
 * `level.ts` uses this to keep furniture clear of, and rings placed on, the
 * path a real flight actually takes. That is NOT the straight line between
 * the two opening centres: when a room's reachable radius (see
 * `maxSteerableRadius`) greatly exceeds the drift the generator actually
 * asked for — which happens often in early, slow rooms, where a whole room's
 * worth of forward time buys far more lateral travel than the opening
 * drift needs — "arrive" steering reaches the target early in the room and
 * then flies level for the remainder, rather than interpolating linearly
 * across it. A furniture margin sized against the straight line alone is not
 * safe against that shape; a margin sized against this simulated path is,
 * because it IS the shape.
 */
export function simulateGliderPath(
  entry: Readonly<{ x: number; y: number; z: number }>,
  exit: Readonly<{ x: number; y: number; z: number }>,
): readonly GliderPathSample[] {
  const samples: GliderPathSample[] = [{ x: entry.x, y: entry.y, z: entry.z }];
  if (exit.z <= entry.z) return samples;

  let state: GliderState = { x: entry.x, y: entry.y, z: entry.z, vx: 0, vy: 0 };
  const target: SteerTarget = { x: exit.x, y: exit.y };

  let guard = 0;
  const GUARD_LIMIT = 200_000;
  while (state.z < exit.z && guard < GUARD_LIMIT) {
    state = stepGlider(state, target);
    samples.push({ x: state.x, y: state.y, z: state.z });
    guard += 1;
  }

  return samples;
}
