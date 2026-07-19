/**
 * Brickrise movement and collision — pure, deterministic, DOM-free.
 *
 * Kept entirely separate from the Phaser renderer so the rules that decide
 * whether a run is fair are unit-testable without a canvas, a game loop, or a
 * browser. Phaser owns drawing; this owns what is true.
 *
 * The binding spec calls for "responsive jump and air control" and "correct
 * collision". Both are encoded here as explicit numbers and an explicit
 * resolution order, rather than emerging from an engine's tuning defaults —
 * otherwise a later engine upgrade silently changes what the player can clear.
 */

/** Axis-aligned box. Origin is top-left; +y is DOWN, matching screen space. */
export type Box = Readonly<{ x: number; y: number; width: number; height: number }>;

export type Velocity = Readonly<{ vx: number; vy: number }>;

export type BodyState = Readonly<{
  box: Box;
  velocity: Velocity;
  /** Standing on a surface this frame. Gates jumping. */
  grounded: boolean;
  /**
   * Frames since the body last left a ledge without jumping. Coyote time makes
   * a jump pressed just after walking off an edge still fire — without it,
   * pixel-accurate timing is required and the climb reads as unresponsive
   * rather than difficult.
   */
  coyoteFrames: number;
  /**
   * Frames since jump was pressed while airborne. Buffering replays the input
   * on landing, so a slightly-early press is honoured instead of dropped.
   */
  jumpBufferFrames: number;
}>;

export type MoveIntent = Readonly<{
  /** -1 left, 0 none, +1 right. Any other value is clamped. */
  direction: number;
  jumpHeld: boolean;
  jumpPressed: boolean;
}>;

/**
 * Tuning. Units are pixels and frames at FIXED_TIMESTEP_MS, never wall-clock —
 * a variable timestep would make the same input clear a gap on a fast machine
 * and miss it on a slow one.
 */
export const BRICKRISE_PHYSICS = Object.freeze({
  FIXED_TIMESTEP_MS: 1000 / 60,
  GRAVITY: 0.62,
  /** Downward speed cap. Prevents tunnelling through thin platforms. */
  MAX_FALL_SPEED: 13,
  RUN_ACCELERATION: 0.9,
  AIR_ACCELERATION: 0.55,
  MAX_RUN_SPEED: 4.6,
  GROUND_FRICTION: 0.78,
  AIR_FRICTION: 0.94,
  /**
   * Must be strong enough to clear BRICKRISE_LEVEL_CONFIG.FLOOR_SPACING.
   * At -11.6 the peak rise was 102.78 px against a 132 px floor gap, so no
   * floor was reachable from the one below and the tower could not be climbed
   * at all — see the reachability test in physics.test.ts, which derives the
   * rise from stepBody rather than trusting this number.
   */
  JUMP_IMPULSE: -14,
  /**
   * Releasing jump early cuts the remaining rise, giving variable jump height
   * from a single button — the core of "air control".
   */
  JUMP_CUT_MULTIPLIER: 0.45,
  COYOTE_FRAMES: 6,
  JUMP_BUFFER_FRAMES: 6,
});

export const INITIAL_BODY_STATE: BodyState = Object.freeze({
  box: Object.freeze({ x: 0, y: 0, width: 24, height: 34 }),
  velocity: Object.freeze({ vx: 0, vy: 0 }),
  grounded: false,
  coyoteFrames: 0,
  jumpBufferFrames: 0,
});

function clampDirection(direction: number): number {
  if (!Number.isFinite(direction)) return 0;
  if (direction > 0) return 1;
  if (direction < 0) return -1;
  return 0;
}

export function boxesOverlap(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.width
    && a.x + a.width > b.x
    && a.y < b.y + b.height
    && a.y + a.height > b.y
  );
}

/**
 * Resolve horizontally, then vertically, against solid boxes.
 *
 * The order matters and is deliberate: resolving both axes simultaneously from
 * a single overlap makes a body walking along a flat floor intermittently
 * register as a side collision at tile seams, which reads as catching on
 * invisible geometry. Sweeping one axis at a time removes that class of bug.
 */
function resolveAxis(
  box: Box,
  solids: readonly Box[],
  deltaX: number,
  deltaY: number,
): { box: Box; hitX: boolean; hitY: boolean } {
  let next: Box = { ...box, x: box.x + deltaX };
  let hitX = false;
  for (const solid of solids) {
    if (!boxesOverlap(next, solid)) continue;
    hitX = true;
    next = {
      ...next,
      x: deltaX > 0 ? solid.x - next.width : solid.x + solid.width,
    };
  }

  let hitY = false;
  next = { ...next, y: next.y + deltaY };
  for (const solid of solids) {
    if (!boxesOverlap(next, solid)) continue;
    hitY = true;
    next = {
      ...next,
      y: deltaY > 0 ? solid.y - next.height : solid.y + solid.height,
    };
  }

  return { box: next, hitX, hitY };
}

/**
 * Advance one fixed step. Pure: same inputs always produce the same output,
 * which is what makes the climb reproducible and the tests meaningful.
 */
export function stepBody(
  state: BodyState,
  intent: MoveIntent,
  solids: readonly Box[],
): BodyState {
  const P = BRICKRISE_PHYSICS;
  const direction = clampDirection(intent.direction);

  // Horizontal: accelerate toward the intended direction, or bleed off speed.
  // Air acceleration is lower than ground so a jump commits without feeling
  // rail-locked.
  const acceleration = state.grounded ? P.RUN_ACCELERATION : P.AIR_ACCELERATION;
  const friction = state.grounded ? P.GROUND_FRICTION : P.AIR_FRICTION;
  let vx = direction !== 0 ? state.velocity.vx + acceleration * direction : state.velocity.vx * friction;
  vx = Math.max(-P.MAX_RUN_SPEED, Math.min(P.MAX_RUN_SPEED, vx));
  if (direction === 0 && Math.abs(vx) < 0.05) vx = 0;

  let vy = state.velocity.vy;

  // Buffer and coyote are decremented every frame; both are "recently true"
  // windows, not latches.
  let jumpBufferFrames = intent.jumpPressed
    ? P.JUMP_BUFFER_FRAMES
    : Math.max(0, state.jumpBufferFrames - 1);
  const canCoyote = state.coyoteFrames > 0;

  let coyoteFrames = state.grounded ? P.COYOTE_FRAMES : Math.max(0, state.coyoteFrames - 1);

  if (jumpBufferFrames > 0 && (state.grounded || canCoyote)) {
    vy = P.JUMP_IMPULSE;
    jumpBufferFrames = 0;
    // Consume both windows so one press cannot yield two jumps.
    coyoteFrames = 0;
  } else if (!intent.jumpHeld && vy < 0) {
    // Variable jump height: releasing early cuts the rise.
    vy *= P.JUMP_CUT_MULTIPLIER;
  }

  vy = Math.min(P.MAX_FALL_SPEED, vy + P.GRAVITY);

  const resolved = resolveAxis(state.box, solids, vx, vy);
  const landed = resolved.hitY && vy > 0;

  return {
    box: resolved.box,
    velocity: {
      vx: resolved.hitX ? 0 : vx,
      vy: resolved.hitY ? 0 : vy,
    },
    grounded: landed,
    // Landing refreshes coyote immediately so a jump buffered mid-fall fires.
    coyoteFrames: landed ? BRICKRISE_PHYSICS.COYOTE_FRAMES : coyoteFrames,
    jumpBufferFrames,
  };
}

/** Place a body so its feet rest on `y`, horizontally centred on `x`. */
export function placeBodyAt(state: BodyState, x: number, y: number): BodyState {
  return {
    ...state,
    box: { ...state.box, x: x - state.box.width / 2, y: y - state.box.height },
    velocity: { vx: 0, vy: 0 },
    grounded: false,
    coyoteFrames: 0,
    jumpBufferFrames: 0,
  };
}
