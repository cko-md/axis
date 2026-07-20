import { describe, expect, it } from "vitest";
import {
  TIME_TO_FLY_ARENA,
  TIME_TO_FLY_PHYSICS,
  TIME_TO_FLY_PLANET_CLASSES,
  type TimeToFlyPlanetClass,
  type TimeToFlyPlanetClassSpec,
} from "@/lib/vector/games/time-to-fly/constants";
import {
  type PlacedPlanet,
  flyArrangement,
  launchState,
  stepCraft,
} from "@/lib/vector/games/time-to-fly/flight";
import {
  __buildCandidateForTest,
  generateTimeToFlyLevel,
} from "@/lib/vector/games/time-to-fly/level";
import {
  CLASS_TURN_CAPACITY,
  everyPlanetNecessary,
  verifyLevel,
} from "@/lib/vector/games/time-to-fly/verify";

/**
 * Measure the true maximum single-pass deflection of a class with the REAL
 * integrator: sweep every survivable impact parameter at 0.5 px resolution and
 * take the largest heading change from field entry to field exit.
 */
function measuredMaxDeflectionRadians(klass: TimeToFlyPlanetClassSpec): number {
  const crashRadius = klass.bodyRadius + TIME_TO_FLY_PHYSICS.SHIP_RADIUS;
  let maxAngle = 0;
  for (let impact = crashRadius - 4; impact <= klass.fieldRadius; impact += 0.5) {
    const planet: PlacedPlanet = {
      id: 0,
      position: { x: 1200, y: TIME_TO_FLY_ARENA.LAUNCH_Y - impact },
      mass: klass.mass,
      bodyRadius: klass.bodyRadius,
      fieldRadius: klass.fieldRadius,
    };
    let craft = launchState();
    let crashed = false;
    let entered = false;
    for (let step = 0; step < TIME_TO_FLY_PHYSICS.MAX_FLIGHT_STEPS; step += 1) {
      craft = stepCraft(craft, [planet]);
      const dx = craft.position.x - planet.position.x;
      const dy = craft.position.y - planet.position.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance <= crashRadius) { crashed = true; break; }
      if (distance < klass.fieldRadius) entered = true;
      else if (entered) break;
    }
    if (crashed || !entered) continue;
    const speed = Math.sqrt(craft.velocity.x ** 2 + craft.velocity.y ** 2);
    const cosine = Math.max(-1, Math.min(1, craft.velocity.x / speed));
    maxAngle = Math.max(maxAngle, Math.acos(cosine));
  }
  return maxAngle;
}

describe("turn-capacity bounds", () => {
  // The cone prune deletes branches it deems unreachable, and the deleted
  // branches decide the solution count — so the per-class bound must sit ABOVE
  // the physics' true maximum deflection, including near-crash passes the
  // generator itself never draws. A previous revision assumed 45 degrees per
  // planet; the true large-class maximum is ~79 degrees, and the difference
  // silently deleted real solutions.
  for (const name of Object.keys(TIME_TO_FLY_PLANET_CLASSES) as TimeToFlyPlanetClass[]) {
    it(`bounds ${name} above its measured maximum deflection`, () => {
      const measured = measuredMaxDeflectionRadians(TIME_TO_FLY_PLANET_CLASSES[name]);
      const capacity = CLASS_TURN_CAPACITY[name];
      // Larger angle means smaller cosine: the bound's cosine must sit BELOW
      // the cosine of the measured maximum.
      expect(
        capacity.cos,
        `${name}: capacity cosine ${capacity.cos} does not clear measured max ${(measured * 180) / Math.PI} degrees`,
      ).toBeLessThan(Math.cos(measured));
      // And the pair must actually be a unit vector for exact angle addition.
      expect(capacity.cos * capacity.cos + capacity.sin * capacity.sin).toBeCloseTo(1, 12);
      expect(capacity.sin).toBeGreaterThan(0);
    });
  }
});

describe("cone prune admissibility", () => {
  it("counts the identical solution set with the prune disabled", () => {
    // The prune is an optimisation and must be INVISIBLE in the result. This
    // is the regression guard for two measured bugs: indexing the cone by
    // pending planets only (the just-assigned planet's deflection is still
    // ahead and must be counted), and per-planet bounds below the physics'
    // true maxima. Either regression makes this test fail on the first seed.
    const cases: { level: number; seed: string }[] = [
      { level: 0, seed: "cone:a" },
      { level: 0, seed: "cone:b" },
      { level: 1, seed: "cone:c" },
      { level: 1, seed: "cone:d" },
      { level: 2, seed: "cone:e" },
      { level: 3, seed: "cone:f" },
    ];
    // Per-case, not one shared cap: with a single global counter the easy
    // level-0/1 cases fill it before levels 2-3 — where the "small" planet
    // class first appears in a multi-planet chain — are ever built, so the
    // admissibility of the prune would go unchecked exactly where it is most
    // likely to be violated.
    const comparedPerCase = cases.map(() => 0);
    cases.forEach(({ level, seed }, caseIndex) => {
      for (let attempt = 0; attempt < 60 && comparedPerCase[caseIndex] < 2; attempt += 1) {
        const candidate = __buildCandidateForTest(level, `${seed}:${attempt}`);
        if (!candidate) continue;
        const pruned = verifyLevel(candidate.planets, candidate.galaxy);
        const unpruned = verifyLevel(
          candidate.planets,
          candidate.galaxy,
          undefined,
          Number.POSITIVE_INFINITY,
          false,
        );
        expect(pruned.exhausted).toBe(false);
        expect(unpruned.exhausted).toBe(false);
        expect(
          pruned.solutions.map((s) => s.join(",")).sort(),
          `pruned and unpruned searches disagree for ${seed}:${attempt} at level ${level + 1}`,
        ).toEqual(unpruned.solutions.map((s) => s.join(",")).sort());
        comparedPerCase[caseIndex] += 1;
      }
    });
    // Every case must have contributed at least one real comparison, so the
    // prune is verified admissible at every planet count present here (1-4),
    // not just the cheapest.
    cases.forEach(({ level, seed }, caseIndex) => {
      expect(
        comparedPerCase[caseIndex],
        `no candidate built for ${seed} at level ${level + 1} — the cone prune was never exercised there`,
      ).toBeGreaterThanOrEqual(1);
    });
  });
});

describe("verifyLevel", () => {
  const level = generateTimeToFlyLevel("verify-suite", 1);

  it("returns only solutions the player's own flight reproduces", () => {
    // The bridge invariant: a verifier solution IS a player flight, bit for
    // bit. flyArrangement is the exact code path the shell will call.
    const verdict = verifyLevel(level.planets, level.galaxy);
    expect(verdict.solutions.length).toBeGreaterThan(0);
    for (const solution of verdict.solutions) {
      const flight = flyArrangement(level.planets, solution, level.galaxy);
      expect(
        flight.outcome,
        `verified solution ${solution.join(",")} did not arrive when flown`,
      ).toBe("arrived");
    }
  });

  it("reports a phase-free aim error for the best solution", () => {
    // Aim error measures the flight line's perpendicular miss of the galaxy
    // centre — near zero for a dead-centre shot, regardless of where inside
    // the capture disc the final step happens to sample.
    const verdict = verifyLevel(level.planets, level.galaxy);
    expect(verdict.bestAim).toBeLessThanOrEqual(verdict.bestApproach);
    expect(verdict.bestAim).toBeLessThanOrEqual(
      TIME_TO_FLY_ARENA.GALAXY_RADIUS * 0.85,
    );
  });

  it("fails closed when the node budget is exhausted", () => {
    const verdict = verifyLevel(level.planets, level.galaxy, 1);
    expect(verdict.exhausted).toBe(true);
  });

  it("stops early at the solution cap and says so", () => {
    const verdict = verifyLevel(level.planets, level.galaxy, undefined, 0);
    expect(verdict.capped).toBe(true);
    expect(verdict.solutions.length).toBeGreaterThanOrEqual(1);
  });

  it("proves every planet necessary by ablation on an accepted level", () => {
    expect(everyPlanetNecessary(level.planets, level.galaxy)).toBe(true);
  });
});
