import { describe, expect, it } from "vitest";
import {
  INITIAL_GLIDER_STATE,
  maxSteerableRadius,
  PAPER_GLIDER_PHYSICS,
  simulateGliderPath,
} from "@/lib/vector/games/paper-glider/physics";
import {
  furnitureSafeTubeRadius,
  generatePaperGliderLevel,
  PAPER_GLIDER_LEVEL_CONFIG,
  type PaperGliderLevel,
  type PaperGliderOpening,
  type PaperGliderRoom,
  roomAtDistance,
} from "@/lib/vector/games/paper-glider/level";
import { initialRunState } from "@/lib/vector/games/paper-glider/progress";
import {
  createPaperGliderSimulation,
  type PaperGliderSimulation,
  stepPaperGliderSimulation,
} from "@/lib/vector/games/paper-glider/simulation";

/**
 * THE BLOCKING COMPLETABILITY GUARD — Paper Glider's analogue of Time to
 * Fly's solvability sweep and Brickrise's reachability test.
 *
 * Wave 15.8 shipped an unclimbable tower with 42 passing tests because every
 * test asserted STRUCTURE and none asserted the game was PLAYABLE. The
 * equivalent failure here is a generated flight that cannot be threaded: a
 * doorway placed beyond the glider's real steering authority, or furniture
 * that blocks the tube a real pursuit actually flies. This file makes that
 * failure loud, in three tiers plus a falsification section:
 *
 *  - A STATIC AUDIT proves every generated doorway is a-priori reachable —
 *    consecutive-opening drift stays inside the physics-derived
 *    `maxSteerableRadius` envelope, and every doorway sits fully inside the
 *    room cross-section. This fails first if the generator ever stops
 *    consulting the physics (the 15.8 "two independently tuned constants"
 *    defect class), even on a seed where a flight happens to survive.
 *  - A DYNAMIC PILOT SWEEP (tiered by cost) flies the REAL
 *    `stepPaperGliderSimulation` through REAL generated levels and must
 *    reach the end of every corpus level without a wall/furniture/bounds
 *    collision. No analytic fast-forward: the pilot advances one fixed step
 *    at a time, exactly as the shell will.
 *  - FALSIFICATION fixtures prove the pilot is not omniscient and the
 *    detector actually fires: three hand-built un-flyable levels — one per
 *    collision reason — flown by the VERY SAME pilot function as the sweep
 *    must each end in the collision that names them.
 *
 * The pilot is bounded and non-omniscient: it "sees" only the centre of the
 * current room's exit doorway and hands that to the simulation as its steer
 * target. All steering authority is mediated by `steerVelocityToward` inside
 * `stepGlider` — the pilot never teleports, never touches velocity directly,
 * and never reads the level beyond the doorway a player would be looking at.
 * `maxSteerableRadius` is what the STATIC tier audits against; the pilot
 * itself gets no help from it.
 *
 * If this sweep ever fails, the defect is the GENERATOR (drift margin,
 * furniture clearance, arrive-steering constants) — fix it there, with its
 * own regression test. Never widen a fixture, never loosen an assertion,
 * never raise a margin to make this file pass.
 *
 * MANUAL FALSIFICATION RECORD (2026-07-20) — beyond the in-suite fixtures
 * below, this guard was proven to fail on a weakened generator by
 * temporarily editing level.ts, running this file, and restoring:
 *
 *  RUN A — the literal 15.8 defect: `maxSteerableRadius(entry.z, ROOM_DEPTH)`
 *  in generatePaperGliderRoom replaced with the stale hand-tuned constant
 *  42.3 (the honest value at z = 0; the real capped-speed floor is 14.1).
 *  Result: 3/8 tests failed —
 *    - static audit: seed "completability-audit-0" room 9 (entry z=320),
 *      drift 16.094 > envelope 11.385;
 *    - standard tier: seed "completability-standard-3" collided (wall) in
 *      room 31 at z=1241.30 after 1145 steps;
 *    - deep tier: seed "completability-deep-0" collided (wall) in room 91
 *      at z=3640.90 after 2859 steps.
 *  The broad tier (12 early rooms, where 42.3 is nearly honest) still
 *  passed — which is exactly why the standard and deep tiers exist.
 *
 *  RUN B — Run A plus the doorway wall clamp removed (dx = rawDx,
 *  dy = rawDy). Result: 4/8 failed — the audit's cross-section check
 *  (audit-0 room 1, doorway centre y=-5.768 outside the ±5 wall band) and
 *  ALL THREE tiers, each with a bounds collision in room 1 (e.g.
 *  "completability-broad-0" at (x=-8.81, y=7.91, z=13.25) after 26 steps).
 *
 *  level.ts was then restored byte-identical (git checkout of that file
 *  alone); the pristine generator passes all 8 tests.
 */

const C = PAPER_GLIDER_LEVEL_CONFIG;
const P = PAPER_GLIDER_PHYSICS;

/**
 * The wall band a doorway is cut into: a doorway centre must keep the whole
 * opening inside the room cross-section, so its centre magnitude is bounded
 * by (room half-extent - opening half-extent) per axis. level.ts enforces
 * this by clamping to the same quantity; the audit recomputes it here rather
 * than importing a private value.
 */
const WALL_HALF_X = C.ROOM_HALF_WIDTH - C.OPENING_HALF_WIDTH;
const WALL_HALF_Y = C.ROOM_HALF_HEIGHT - C.OPENING_HALF_HEIGHT;

type PilotResult = Readonly<{
  seed: string;
  roomsCleared: number;
  steps: number;
  collided: boolean;
  collisionReason: string | null;
  /** Body position at the moment the flight ended (collision or corpus end). */
  finalX: number;
  finalY: number;
  finalZ: number;
}>;

/**
 * Fly a simulation with the bounded pilot until `targetRooms` rooms are
 * cleared, a collision ends the run, or the step budget runs out. ONE
 * authoritative fixed step per iteration — `stepPaperGliderSimulation` is the
 * same per-frame entry point the shell calls; nothing here advances state any
 * other way.
 *
 * The step budget is a liveness backstop, not a difficulty knob: early rooms
 * take ~80 steps (speed 0.5) and capped rooms ~29 (speed 1.4), so 100 steps
 * per room can only be exhausted if forward motion itself broke — which the
 * roomsCleared assertion then reports.
 */
function flyPilot(simulation: PaperGliderSimulation, targetRooms: number): PilotResult {
  const maxSteps = targetRooms * 100;
  let sim = simulation;
  let roomsCleared = 0;
  let steps = 0;

  for (; steps < maxSteps && roomsCleared < targetRooms; steps += 1) {
    const room = roomAtDistance(sim.level, sim.body.z);
    const result = stepPaperGliderSimulation(sim, { x: room.exit.x, y: room.exit.y });
    sim = result.simulation;

    for (const event of result.events) {
      if (event.type === "roomCleared") roomsCleared += 1;
      if (event.type === "collision") {
        return {
          seed: sim.run.seed,
          roomsCleared,
          steps: steps + 1,
          collided: true,
          collisionReason: event.reason,
          finalX: sim.body.x,
          finalY: sim.body.y,
          finalZ: sim.body.z,
        };
      }
    }
  }

  return {
    seed: sim.run.seed,
    roomsCleared,
    steps,
    collided: false,
    collisionReason: null,
    finalX: sim.body.x,
    finalY: sim.body.y,
    finalZ: sim.body.z,
  };
}

function expectFlyable(result: PilotResult, targetRooms: number): void {
  expect(
    result.collided,
    `seed "${result.seed}": UN-FLYABLE — collided (${result.collisionReason}) in room `
      + `${result.roomsCleared + 1} at (x=${result.finalX.toFixed(2)}, y=${result.finalY.toFixed(2)}, `
      + `z=${result.finalZ.toFixed(2)}) after ${result.steps} steps. The generator produced a level `
      + `the real dynamics cannot thread; fix the generator, not this test.`,
  ).toBe(false);
  expect(
    result.roomsCleared,
    `seed "${result.seed}": pilot stalled — cleared only ${result.roomsCleared}/${targetRooms} rooms `
      + `in ${result.steps} steps without colliding; forward progress itself broke.`,
  ).toBeGreaterThanOrEqual(targetRooms);
}

describe("completability — static reachability audit", () => {
  it("keeps every generated doorway inside the physics-derived steerable envelope and the room cross-section", () => {
    // 30 seeds x 60 rooms = 1,800 rooms, spanning z = 0..2,400 — well past
    // distanceToSpeedCap() = 600, so the capped-speed regime (where the
    // envelope is tightest: maxSteerableRadius floors at 14.1) is audited,
    // not just the forgiving early ramp (42.3 at z = 0).
    for (let s = 0; s < 30; s += 1) {
      const seed = `completability-audit-${s}`;
      const level = generatePaperGliderLevel(seed, 60);
      for (const room of level.rooms) {
        const dx = room.exit.x - room.entry.x;
        const dy = room.exit.y - room.entry.y;
        // Determinism-rule arithmetic only: squares and sqrt, no hypot/trig.
        const drift = Math.sqrt(dx * dx + dy * dy);
        const envelope = C.OPENING_DRIFT_SAFETY_MARGIN * maxSteerableRadius(room.entry.z, C.ROOM_DEPTH);
        expect(
          drift,
          `seed "${seed}" room ${room.index} (entry z=${room.entry.z}): opening drift ${drift.toFixed(3)} `
            + `exceeds the physics-derived envelope ${envelope.toFixed(3)} — the generator has stopped `
            + `honouring maxSteerableRadius (the 15.8 defect class).`,
        ).toBeLessThanOrEqual(envelope + 1e-9);

        expect(
          Math.abs(room.exit.x),
          `seed "${seed}" room ${room.index}: doorway centre x=${room.exit.x.toFixed(3)} puts the opening `
            + `outside the room's ±${C.ROOM_HALF_WIDTH} interior`,
        ).toBeLessThanOrEqual(WALL_HALF_X + 1e-9);
        expect(
          Math.abs(room.exit.y),
          `seed "${seed}" room ${room.index}: doorway centre y=${room.exit.y.toFixed(3)} puts the opening `
            + `outside the room's ±${C.ROOM_HALF_HEIGHT} interior`,
        ).toBeLessThanOrEqual(WALL_HALF_Y + 1e-9);
      }
    }
  });

  it("keeps every furniture box clear of the flight tube across the box's FULL z-extent, not just its centre z", () => {
    // REGRESSION GUARD (the swept-clearance furniture defect): the generator
    // once sampled the flight path at the box's centre z only. A furniture box
    // is z-thick, and during each room's steering ramp-up the path's (x, y)
    // sweeps fastest per z-unit — so a box whose centre-z sample cleared the
    // tube could still have its NEAR edge inside it, producing levels no
    // pilot could thread (16 such boxes existed in this very corpus). This
    // audit re-simulates each room's generation-time path and takes the
    // minimum clearance over each box's whole z-range, the same shape the
    // runtime `collidesFurniture` tests. If it fails, fix generateFurniture's
    // sweep — never this audit.
    const safe = furnitureSafeTubeRadius();
    const safeSquared = safe * safe;
    for (let s = 0; s < 30; s += 1) {
      const seed = `completability-audit-${s}`;
      const level = generatePaperGliderLevel(seed, 60);
      for (const room of level.rooms) {
        const path = simulateGliderPath(room.entry, room.exit);
        for (const box of room.furniture) {
          const zMin = box.z - box.halfZ - P.HULL_RADIUS;
          const zMax = box.z + box.halfZ + P.HULL_RADIUS;
          let minSquared = Infinity;
          for (const sample of path) {
            if (sample.z < zMin || sample.z > zMax) continue;
            const dx = box.x - sample.x;
            const dy = box.y - sample.y;
            const distanceSquared = dx * dx + dy * dy;
            if (distanceSquared < minSquared) minSquared = distanceSquared;
          }
          expect(
            minSquared,
            `seed "${seed}" room ${room.index}: furniture at (x=${box.x.toFixed(2)}, y=${box.y.toFixed(2)}, `
              + `z=${box.z.toFixed(2)}) leaves swept flight-tube clearance ${Math.sqrt(minSquared).toFixed(3)} `
              + `< safe tube radius ${safe.toFixed(3)} somewhere inside its z-extent — the single-z-sample `
              + `placement defect is back.`,
          ).toBeGreaterThanOrEqual(safeSquared);
        }
      }
    }
  });

  it("pins the headroom relations the audit's meaning depends on", () => {
    // The envelope check above only proves flyability if using LESS than the
    // full theoretical radius, and if a doorway is wider than the hull. These
    // are the two relations whose silent inversion would rot the audit into
    // a tautology.
    expect(C.OPENING_DRIFT_SAFETY_MARGIN).toBeGreaterThan(0);
    expect(C.OPENING_DRIFT_SAFETY_MARGIN).toBeLessThan(1);
    expect(C.OPENING_HALF_WIDTH).toBeGreaterThan(P.HULL_RADIUS);
    expect(C.OPENING_HALF_HEIGHT).toBeGreaterThan(P.HULL_RADIUS);
  });
});

describe("completability — dynamic pilot sweep (tiered by cost)", () => {
  // Tier sizes are calibrated from measured cost on the suite's own hardware
  // class (generation dominates; flying is cheap): 20 seeds x 40 rooms
  // measured ~163 ms, one 150-room flight ~53 ms. The whole sweep stays
  // under ~1 s while covering three regimes:

  it("broad tier: 80 seeds fly the first 12 rooms — the spawn/ramp-up region every real run begins with", () => {
    // 12 rooms is exactly INITIAL_ROOM_COUNT: the content a run's first
    // impression is made of. Breadth over depth here — a systematic
    // generator regression fails many seeds at once, so the widest net goes
    // where every player starts.
    for (let s = 0; s < 80; s += 1) {
      const result = flyPilot(createPaperGliderSimulation(`completability-broad-${s}`), 12);
      expectFlyable(result, 12);
    }
  });

  it("standard tier: 25 seeds fly 40 rooms — crossing distanceToSpeedCap into the capped-speed regime", () => {
    // The speed curve caps at z = 600 = room 15, where steering authority is
    // at its floor (maxSteerableRadius = 14.1 vs 42.3 at spawn) and the
    // drift envelope is tightest. Rooms 16-40 of every one of these seeds
    // are flown entirely at the cap.
    for (let s = 0; s < 25; s += 1) {
      const result = flyPilot(createPaperGliderSimulation(`completability-standard-${s}`), 40);
      expectFlyable(result, 40);
    }
  });

  it("deep tier: 4 seeds fly 150 rooms — deep capped-speed flight through ~18 in-flight level extensions", () => {
    // z reaches 6,000. Past room 12 every room the pilot flies was appended
    // by ensureRoomsAhead inside stepPaperGliderSimulation itself, so this
    // tier proves the extension path — generation resumed mid-flight from a
    // prior exit, not just a fresh generatePaperGliderLevel call — obeys the
    // same completability bound. (~(150 - 12) / EXTEND_BATCH = 18 extensions.)
    for (let s = 0; s < 4; s += 1) {
      const result = flyPilot(createPaperGliderSimulation(`completability-deep-${s}`), 150);
      expectFlyable(result, 150);
    }
  }, 30_000);

  it("fuzz tier: 1,500 arithmetically-derived seeds fly the first 15 rooms — statistical power against sub-1% defects", () => {
    // Production seeds come from crypto.randomUUID(), an unbounded space; the
    // fixed tiers above hold ~190 hardcoded strings between them. The swept-
    // clearance furniture defect killed only ~0.2% of seeds, so those ~190
    // seeds had roughly a 3-in-4 chance of all flying clean over the very
    // generator that was broken (and did: the whole suite passed with the
    // defect present). This tier is an order of magnitude wider — measured to
    // catch that defect class reliably (2 hits in this exact corpus against
    // the pre-fix generator) at ~0.7 s of runtime. Seeds are DERIVED, not
    // literal, so the corpus cannot be quietly edited around a failure, and
    // `expectFlyable` prints the failing seed so any hit reproduces
    // standalone. 15 rooms per seed keeps the weight on the ramp-up region
    // where furniture-vs-curvature defects concentrate, while still crossing
    // distanceToSpeedCap (room 15) for late-regime coverage.
    for (let s = 0; s < 1500; s += 1) {
      const seed = `completability-fuzz-${s}-${(s * 2654435761) % 4294967296}`;
      const result = flyPilot(createPaperGliderSimulation(seed), 15);
      expectFlyable(result, 15);
    }
  }, 30_000);
});

describe("completability — regression: witness seeds of the swept-clearance furniture defect", () => {
  // Each of these seeds, found by independent adversarial probes, generated a
  // level with a furniture box whose centre-z path sample cleared
  // furnitureSafeTubeRadius() while the box's actual [z - halfZ, z + halfZ]
  // volume intruded into the flown tube — an un-flyable level the fixed-tier
  // sweep never sampled. All eight collided (reason: "furniture") on the
  // pre-fix generator and must fly clean forever after. If one ever fails
  // again, the generator's z-sweep in generateFurniture regressed — fix it
  // there, never here.
  const WITNESS_SEEDS = [
    "probe-random-248-1170072440", // room 3, box at z≈88.4, swept clearance 1.54 < 2.40
    "probe-deep-27", // room 1, died at z≈7.6 — near-zero entry velocity, pure ramp-up curvature
    "probe-furniture-scan-47", // room 5, FURNITURE_PER_ROOM_MAX-density room
    "probe-furniture-scan-82", // room 2
    "review-probe-107-556784891", // room 1, swept min clearance 1.24 at z=5.54 vs required 2.40
    "zz-probe-616-3044856296", // room 3, died at z≈87.2
    "zz-probe-3267-502660563", // room 4, hull grazing the doorway edge beside a marginal box
    "zz-deepprobe-286-11583865", // room 5, reached through extendPaperGliderLevel's extension path
  ];

  it("flies every witness seed clean through 15 rooms with the standard bounded pilot", () => {
    for (const seed of WITNESS_SEEDS) {
      const result = flyPilot(createPaperGliderSimulation(seed), 15);
      expectFlyable(result, 15);
    }
  });
});

describe("completability — falsification: the detector fires on un-flyable levels", () => {
  // These fixtures are flown by the IDENTICAL flyPilot used by the sweep
  // above. Each is a minimal level that is un-flyable in exactly one way, and
  // each must end in the collision that names it — proving the sweep's green
  // is a detector staying quiet, not a detector that cannot fire.
  //
  // Note on level extension: stepPaperGliderSimulation auto-extends any level
  // whose remaining depth is short, appending REAL generated rooms after the
  // fixture's. That is harmless here — every fixture kills the flight inside
  // fixture room 1, before any appended content is reachable.

  function fixtureOpening(index: number, x: number, y: number, z: number): PaperGliderOpening {
    return { index, x, y, halfWidth: C.OPENING_HALF_WIDTH, halfHeight: C.OPENING_HALF_HEIGHT, z };
  }

  function fixtureSimulation(rooms: readonly PaperGliderRoom[]): PaperGliderSimulation {
    const level: PaperGliderLevel = { seed: "completability-fixture", rooms };
    return { level, body: INITIAL_GLIDER_STATE, run: initialRunState("completability-fixture") };
  }

  it("a doorway beyond steering authority is detected as a wall collision", () => {
    // A room only 4 z-units deep whose exit doorway is displaced to the wall
    // band edge (x = 6.5). Crossing takes ceil(4 / 0.5) = 8 steps; ramping at
    // STEER_ACCEL = 0.05/step the glider can travel at most
    // 0.05 * (1+2+...+8) = 1.8 lateral units in that time (measured: x = 1.80
    // at the crossing step), but entering the doorway needs
    // 6.5 - (3.5 - 0.35) = 3.35. Provably unreachable — the exact "opening
    // outside reach" defect the sweep exists to catch.
    const entry = fixtureOpening(0, 0, 0, 0);
    const exit = fixtureOpening(1, WALL_HALF_X, 0, 4);
    const room: PaperGliderRoom = { index: 1, entry, exit, furniture: [], rings: [] };

    const result = flyPilot(fixtureSimulation([room]), 5);

    expect(result.collided, "an unreachable doorway flew clean — the completability detector is broken").toBe(true);
    expect(result.collisionReason).toBe("wall");
    expect(result.roomsCleared).toBe(0);
    expect(result.steps).toBeLessThanOrEqual(20); // fires AT the wall plane, not eventually
  });

  it("furniture parked on the flight tube is detected as a furniture collision", () => {
    // A straight room with one standard-size furniture box centred exactly on
    // the path the pilot's pursuit flies (the centreline). The generator's
    // furnitureSafeTubeRadius() clearance rule exists precisely to forbid
    // this placement; if it ever regresses, this is what the sweep would see.
    // Measured: hull meets the box at z ≈ 18.48 (box front face at
    // z = 20 - 1.6 - 0.35 = 18.05, first step-sample beyond it).
    const entry = fixtureOpening(0, 0, 0, 0);
    const exit = fixtureOpening(1, 0, 0, C.ROOM_DEPTH);
    const room: PaperGliderRoom = {
      index: 1,
      entry,
      exit,
      furniture: [
        {
          x: 0,
          y: 0,
          z: C.ROOM_DEPTH / 2,
          halfX: C.FURNITURE_HALF_SIZE_XY,
          halfY: C.FURNITURE_HALF_SIZE_XY,
          halfZ: C.FURNITURE_HALF_SIZE_Z,
        },
      ],
      rings: [],
    };

    const result = flyPilot(fixtureSimulation([room]), 5);

    expect(result.collided, "path-blocking furniture flew clean — the completability detector is broken").toBe(true);
    expect(result.collisionReason).toBe("furniture");
    expect(result.roomsCleared).toBe(0);
  });

  it("a doorway placed outside the room interior is detected as a bounds collision", () => {
    // Exit doorway centred at x = 14, outside the ±10 room interior — a
    // doorway no interior flight path can enter. The pilot honestly chasing
    // it leaves the open interior (|x| > 10 - 0.35 = 9.65) and dies at the
    // side wall (measured: x = 9.90 at z ≈ 11.17) long before the doorway
    // plane at z = 40.
    const entry = fixtureOpening(0, 0, 0, 0);
    const exit = fixtureOpening(1, 14, 0, C.ROOM_DEPTH);
    const room: PaperGliderRoom = { index: 1, entry, exit, furniture: [], rings: [] };

    const result = flyPilot(fixtureSimulation([room]), 5);

    expect(result.collided, "an out-of-bounds doorway flew clean — the completability detector is broken").toBe(true);
    expect(result.collisionReason).toBe("bounds");
    expect(result.roomsCleared).toBe(0);
    expect(result.finalZ).toBeLessThan(C.ROOM_DEPTH); // died at the side wall, never reached the doorway plane
  });
});
