import { describe, expect, it } from "vitest";
import {
  TIME_TO_FLY_ARENA,
  TIME_TO_FLY_PHYSICS,
  TIME_TO_FLY_PLANET_CLASSES,
  TIME_TO_FLY_SLOT_COUNT,
  TIME_TO_FLY_SLOT_UNITS,
  type TimeToFlyPlanetClassSpec,
} from "@/lib/vector/games/time-to-fly/constants";
import {
  type PlacedPlanet,
  accelerationAt,
  flyArrangement,
  launchState,
  simulateFlight,
  stepCraft,
} from "@/lib/vector/games/time-to-fly/flight";
import {
  type TimeToFlyPlanet,
  allFieldsDisjoint,
  normalizeSlot,
  planetPositionAt,
  rayReachesDisc,
  reachRadius,
} from "@/lib/vector/games/time-to-fly/orbit";

function placed(overrides: Partial<PlacedPlanet> = {}): PlacedPlanet {
  const large = TIME_TO_FLY_PLANET_CLASSES.large;
  return {
    id: 0,
    position: { x: 800, y: TIME_TO_FLY_ARENA.LAUNCH_Y },
    mass: large.mass,
    bodyRadius: large.bodyRadius,
    fieldRadius: large.fieldRadius,
    ...overrides,
  };
}

describe("slot lattice", () => {
  it("matches trigonometry it never calls at runtime", () => {
    // The table is hardcoded so no transcendental runs on the simulation path.
    // This test is what makes hardcoding safe rather than superstitious.
    TIME_TO_FLY_SLOT_UNITS.forEach((unit, slot) => {
      const angle = (slot * Math.PI * 2) / TIME_TO_FLY_SLOT_COUNT;
      expect(unit.x).toBeCloseTo(Math.cos(angle), 12);
      expect(unit.y).toBeCloseTo(Math.sin(angle), 12);
    });
  });

  it("has exactly unit length at every slot", () => {
    for (const unit of TIME_TO_FLY_SLOT_UNITS) {
      expect(Math.sqrt(unit.x * unit.x + unit.y * unit.y)).toBeCloseTo(1, 12);
    }
  });

  it("keeps the cardinal directions exact", () => {
    // Exactness at the cardinals is what stops a planet placed "straight up"
    // from sitting a sub-pixel off and making a level seed-dependent.
    const quarter = TIME_TO_FLY_SLOT_COUNT / 4;
    expect(TIME_TO_FLY_SLOT_UNITS[0]).toEqual({ x: 1, y: 0 });
    expect(TIME_TO_FLY_SLOT_UNITS[quarter]).toEqual({ x: 0, y: 1 });
    expect(TIME_TO_FLY_SLOT_UNITS[quarter * 2]).toEqual({ x: -1, y: 0 });
    expect(TIME_TO_FLY_SLOT_UNITS[quarter * 3]).toEqual({ x: 0, y: -1 });
  });

  it("wraps slots rather than clamping them", () => {
    // Dragging past the top must come round, or the orbit grows invisible walls.
    expect(normalizeSlot(TIME_TO_FLY_SLOT_COUNT)).toBe(0);
    expect(normalizeSlot(-1)).toBe(TIME_TO_FLY_SLOT_COUNT - 1);
    expect(normalizeSlot(TIME_TO_FLY_SLOT_COUNT * 3 + 5)).toBe(5);
    expect(normalizeSlot(Number.NaN)).toBe(0);
  });
});

describe("gravity field", () => {
  it("is exactly zero at and beyond the field rim", () => {
    // Finite support is what makes each planet a legible gate: between fields
    // the craft travels an exact straight line.
    const planet = placed({ position: { x: 0, y: 0 } });
    const rim = { x: planet.fieldRadius, y: 0 };
    const beyond = { x: planet.fieldRadius + 1, y: 0 };

    expect(accelerationAt(rim, [planet])).toEqual({ x: 0, y: 0 });
    expect(accelerationAt(beyond, [planet])).toEqual({ x: 0, y: 0 });
  });

  it("pulls toward the planet and strengthens as the craft closes in", () => {
    const planet = placed({ position: { x: 0, y: 0 } });
    const far = accelerationAt({ x: planet.fieldRadius - 10, y: 0 }, [planet]);
    const near = accelerationAt({ x: planet.fieldRadius / 3, y: 0 }, [planet]);

    // Toward the planet, which sits at the origin.
    expect(far.x).toBeLessThan(0);
    expect(near.x).toBeLessThan(far.x);
  });

  it("gives larger planets both a stronger pull and a longer reach", () => {
    // The binding spec: "larger planets exert stronger force across a larger
    // field". Both halves are asserted — a bigger planet that were merely
    // stronger at the same radius would not satisfy it.
    const classes = TIME_TO_FLY_PLANET_CLASSES;
    expect(classes.small.fieldRadius).toBeLessThan(classes.medium.fieldRadius);
    expect(classes.medium.fieldRadius).toBeLessThan(classes.large.fieldRadius);

    const sample = { x: 60, y: 0 };
    const strength = (klass: TimeToFlyPlanetClassSpec) =>
      Math.abs(
        accelerationAt(sample, [
          placed({
            position: { x: 0, y: 0 },
            mass: klass.mass,
            fieldRadius: klass.fieldRadius,
            bodyRadius: klass.bodyRadius,
          }),
        ]).x,
      );

    expect(strength(classes.small)).toBeLessThan(strength(classes.medium));
    expect(strength(classes.medium)).toBeLessThan(strength(classes.large));
  });

  it("deflects strictly less the further off-centre the craft passes", () => {
    // Entry geometry, the spec's third gravity input, and the property that
    // makes a field readable without a trajectory preview: closer must always
    // mean more turn. This test is why GRAVITY is 0.01 — at 0.014 and above the
    // curve grows a second lobe and two different approaches deflect equally.
    //
    // Swept only over passes the craft SURVIVES. Below the crash threshold the
    // relationship genuinely does invert (a near-graze is pulled almost
    // symmetrically, so net transverse impulse falls again), but the craft is
    // destroyed there, so it is not a pass a player can choose.
    const flyPast = (impactParameter: number) => {
      const planet = placed({ position: { x: 900, y: TIME_TO_FLY_ARENA.LAUNCH_Y - impactParameter } });
      let craft = launchState();
      let closest = Number.POSITIVE_INFINITY;
      for (let step = 0; step < 900; step += 1) {
        craft = stepCraft(craft, [planet]);
        const dx = craft.position.x - planet.position.x;
        const dy = craft.position.y - planet.position.y;
        closest = Math.min(closest, Math.sqrt(dx * dx + dy * dy));
      }
      return { deflection: craft.velocity.y, survived: closest > planet.bodyRadius + TIME_TO_FLY_PHYSICS.SHIP_RADIUS };
    };

    const survivable = [];
    for (let impact = 30; impact <= 215; impact += 5) {
      const result = flyPast(impact);
      if (result.survived) survivable.push({ impact, deflection: result.deflection });
    }

    expect(survivable.length).toBeGreaterThan(20);
    for (let i = 1; i < survivable.length; i += 1) {
      expect(
        survivable[i].deflection,
        `deflection was not strictly weaker at impact ${survivable[i].impact} than at ${survivable[i - 1].impact}`,
      ).toBeGreaterThan(survivable[i - 1].deflection);
    }
  });

  it("gives each planet class a distinct, size-ordered steering authority", () => {
    // A player who has learned what a large planet can do on level 1 must find
    // it does the same thing on level 5.
    const maxTurnFor = (klass: TimeToFlyPlanetClassSpec) => {
      let strongest = 0;
      for (let impact = 20; impact <= klass.fieldRadius - 5; impact += 5) {
        const planet = placed({
          position: { x: 900, y: TIME_TO_FLY_ARENA.LAUNCH_Y - impact },
          mass: klass.mass,
          bodyRadius: klass.bodyRadius,
          fieldRadius: klass.fieldRadius,
        });
        let craft = launchState();
        let closest = Number.POSITIVE_INFINITY;
        for (let step = 0; step < 900; step += 1) {
          craft = stepCraft(craft, [planet]);
          const dx = craft.position.x - planet.position.x;
          const dy = craft.position.y - planet.position.y;
          closest = Math.min(closest, Math.sqrt(dx * dx + dy * dy));
        }
        if (closest > klass.bodyRadius + TIME_TO_FLY_PHYSICS.SHIP_RADIUS) {
          strongest = Math.max(strongest, -craft.velocity.y);
        }
      }
      return strongest;
    };

    const small = maxTurnFor(TIME_TO_FLY_PLANET_CLASSES.small);
    const medium = maxTurnFor(TIME_TO_FLY_PLANET_CLASSES.medium);
    const large = maxTurnFor(TIME_TO_FLY_PLANET_CLASSES.large);

    expect(small).toBeLessThan(medium);
    expect(medium).toBeLessThan(large);
    // And all three must be able to steer meaningfully, or the class is decorative.
    expect(small).toBeGreaterThan(0.5);
  });

  it("superposes multiple fields", () => {
    const a = placed({ id: 0, position: { x: 100, y: 0 } });
    const b = placed({ id: 1, position: { x: -100, y: 0 } });
    const sample = { x: 0, y: 0 };

    const combined = accelerationAt(sample, [a, b]);
    const onlyA = accelerationAt(sample, [a]);
    const onlyB = accelerationAt(sample, [b]);

    expect(combined.x).toBeCloseTo(onlyA.x + onlyB.x, 12);
    expect(combined.y).toBeCloseTo(onlyA.y + onlyB.y, 12);
  });
});

describe("flight", () => {
  const galaxy = { x: TIME_TO_FLY_ARENA.LAUNCH_X + 1800, y: TIME_TO_FLY_ARENA.LAUNCH_Y };

  it("coasts in an exact straight line through empty space", () => {
    let craft = launchState();
    for (let step = 0; step < 50; step += 1) craft = stepCraft(craft, []);

    expect(craft.velocity).toEqual({ x: TIME_TO_FLY_PHYSICS.LAUNCH_SPEED, y: 0 });
    expect(craft.position.y).toBe(TIME_TO_FLY_ARENA.LAUNCH_Y);
  });

  it("reaches a galaxy placed straight ahead with no planets in the way", () => {
    const result = simulateFlight([], galaxy);
    expect(result.outcome).toBe("arrived");
  });

  it("reports a crash and which planet was struck", () => {
    const blocker = placed({ id: 3, position: { x: 900, y: TIME_TO_FLY_ARENA.LAUNCH_Y } });
    const result = simulateFlight([blocker], galaxy);

    expect(result.outcome).toBe("crashed");
    expect(result.crashedInto).toBe(3);
  });

  it("cannot tunnel through a planet body", () => {
    // Guarded by construction: the craft moves at most LAUNCH_SPEED per step,
    // while the smallest lethal radius is a small body plus the ship.
    const smallest = TIME_TO_FLY_PLANET_CLASSES.small.bodyRadius + TIME_TO_FLY_PHYSICS.SHIP_RADIUS;
    expect(TIME_TO_FLY_PHYSICS.LAUNCH_SPEED).toBeLessThan(smallest);
  });

  it("terminates on every path", () => {
    // A craft flung into empty space must end the flight, not hang the runtime.
    const result = simulateFlight([], { x: -99999, y: -99999 });
    expect(["out-of-bounds", "timeout"]).toContain(result.outcome);
    expect(result.steps).toBeLessThanOrEqual(TIME_TO_FLY_PHYSICS.MAX_FLIGHT_STEPS);
  });

  it("is bit-identical across repeated runs", () => {
    const planets: TimeToFlyPlanet[] = [
      { id: 0, planetClass: "large", orbitCenter: { x: 800, y: TIME_TO_FLY_ARENA.LAUNCH_Y - 120 }, orbitRadius: 96 },
    ];
    const a = flyArrangement(planets, [7], galaxy);
    const b = flyArrangement(planets, [7], galaxy);

    // Not "close to" — identical. The verifier's answer and the player's flight
    // must be the same flight.
    expect(a.craft.position.x).toBe(b.craft.position.x);
    expect(a.craft.position.y).toBe(b.craft.position.y);
    expect(a.steps).toBe(b.steps);
    expect(a.closestApproach).toBe(b.closestApproach);
  });

  it("changes outcome when a planet moves one slot", () => {
    // If a one-slot nudge never mattered, the lattice would be too fine to
    // reason about and the puzzle would be a continuum in disguise.
    const planets: TimeToFlyPlanet[] = [
      { id: 0, planetClass: "large", orbitCenter: { x: 900, y: TIME_TO_FLY_ARENA.LAUNCH_Y - 140 }, orbitRadius: 124 },
    ];
    const outcomes = new Set(
      Array.from({ length: TIME_TO_FLY_SLOT_COUNT }, (_, slot) =>
        Math.round(flyArrangement(planets, [slot], galaxy).closestApproach),
      ),
    );
    expect(outcomes.size).toBeGreaterThan(1);
  });
});

describe("reach discs", () => {
  const planet: TimeToFlyPlanet = {
    id: 0,
    planetClass: "medium",
    orbitCenter: { x: 500, y: 500 },
    orbitRadius: 84,
  };

  it("bound every position the planet's gravity can ever occupy", () => {
    const reach = reachRadius(planet);
    for (let slot = 0; slot < TIME_TO_FLY_SLOT_COUNT; slot += 1) {
      const position = planetPositionAt(planet, slot);
      const dx = position.x - planet.orbitCenter.x;
      const dy = position.y - planet.orbitCenter.y;
      const fromCentre = Math.sqrt(dx * dx + dy * dy);
      expect(fromCentre + TIME_TO_FLY_PLANET_CLASSES.medium.fieldRadius).toBeLessThanOrEqual(reach + 1e-9);
    }
  });

  it("detects overlap regardless of arrangement", () => {
    const near: TimeToFlyPlanet = { ...planet, id: 1, orbitCenter: { x: 560, y: 500 } };
    const far: TimeToFlyPlanet = { ...planet, id: 2, orbitCenter: { x: 1400, y: 500 } };

    expect(allFieldsDisjoint([planet, near])).toBe(false);
    expect(allFieldsDisjoint([planet, far])).toBe(true);
  });
});

describe("rayReachesDisc", () => {
  it("is a prune predicate, not a state advance", () => {
    const origin = { x: 0, y: 0 };
    const east = { x: 1, y: 0 };

    expect(rayReachesDisc(origin, east, { x: 100, y: 0 }, 10)).toBe(true);
    expect(rayReachesDisc(origin, east, { x: 100, y: 50 }, 10)).toBe(false);
    // Behind the craft is unreachable — a ray, not a line.
    expect(rayReachesDisc(origin, east, { x: -100, y: 0 }, 10)).toBe(false);
  });

  it("never rejects a disc the stepped flight actually enters", () => {
    // Soundness: pruning may over-approximate, but it must not discard a
    // branch the real simulation would have flown into.
    for (let offset = -160; offset <= 160; offset += 20) {
      const planet = placed({ position: { x: 900, y: TIME_TO_FLY_ARENA.LAUNCH_Y + offset } });
      const entered = (() => {
        let craft = launchState();
        for (let step = 0; step < 600; step += 1) {
          craft = stepCraft(craft, [planet]);
          const dx = craft.position.x - planet.position.x;
          const dy = craft.position.y - planet.position.y;
          if (Math.sqrt(dx * dx + dy * dy) < planet.fieldRadius) return true;
        }
        return false;
      })();

      if (entered) {
        expect(
          rayReachesDisc(launchState().position, launchState().velocity, planet.position, planet.fieldRadius),
          `offset ${offset}: flight entered the field but the prune predicate said no`,
        ).toBe(true);
      }
    }
  });
});
