import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * THE DETERMINISM SOURCE GUARD — Paper Glider's generation and simulation
 * path must use only + - * / and sqrt.
 *
 * Math.sqrt is required by IEEE 754 (and ECMA-262) to be correctly rounded,
 * so it is bit-identical on every conforming engine. Every OTHER
 * transcendental-ish Math function — sin, cos, atan2, and notably
 * Math.hypot — is implementation-approximated: two engines (or two versions
 * of one engine) may legally disagree in the last ULP. Because the fixed-step
 * simulation feeds each step's output into the next step's input, a single
 * ULP of disagreement compounds into a macroscopically different flight — and
 * because the level generator derives doorway/furniture/ring placement from
 * the same step function (`simulateGliderPath`, `maxSteerableRadius`), it can
 * even produce a *different level* for the same seed. That silently breaks
 * every replay/passability guarantee the pure modules document.
 *
 * This is a source scan, same mechanism as game.test.ts's rAF/animation-loop
 * scan, because the defect class is invisible to behavioural tests running on
 * a single engine: within one engine the flight is always self-consistent.
 * The scan is what fails when someone reintroduces Math.hypot (as the
 * original Wave 15.10 draft did in physics.ts, level.ts, AND simulation.ts
 * while its own test files were already carefully using sqrt).
 *
 * game.ts is deliberately NOT scanned: Three.js rendering (camera lookAt,
 * cosmetic attitude) sits strictly downstream of the simulation and may use
 * trig freely — the rule protects what feeds the simulation, not what draws
 * its output.
 */

/** Every module on the simulation/generation side of the shell boundary. */
const PURE_MODULE_PATHS = [
  "src/lib/vector/games/paper-glider/physics.ts",
  "src/lib/vector/games/paper-glider/level.ts",
  "src/lib/vector/games/paper-glider/simulation.ts",
  "src/lib/vector/games/paper-glider/progress.ts",
  "src/lib/vector/games/paper-glider/inputState.ts",
  "src/lib/vector/games/paper-glider/rng.ts",
];

/**
 * The implementation-approximated Math functions (ECMA-262 explicitly allows
 * these to differ between implementations), plus Math.random (banned for the
 * separate reason that all randomness must flow through the seeded rng).
 * Math.sqrt, the arithmetic operators, and exact integer/structural helpers
 * (min/max/abs/floor/round/imul/trunc/sign) are the permitted set.
 */
const BANNED_MATH_CALL = /Math\.(?:hypot|sinh?|cosh?|tanh?|asinh?|acosh?|atan2|atanh?|pow|exp|expm1|log1p|log10|log2|log|cbrt|random)\s*\(/g;

describe("determinism — the simulation and generation path uses only + - * / and sqrt", () => {
  it("contains no implementation-approximated Math call in any pure module", () => {
    for (const path of PURE_MODULE_PATHS) {
      const source = readFileSync(path, "utf8");
      // A moved or emptied file must fail loudly rather than scan vacuously.
      expect(source.length, `${path} is empty or unreadable — the scan proved nothing`).toBeGreaterThan(0);

      const hits = [...source.matchAll(BANNED_MATH_CALL)].map((match) => {
        const line = source.slice(0, match.index).split("\n").length;
        return `${path}:${line} uses ${match[0].trimEnd()}...)`;
      });
      expect(
        hits,
        `banned Math call(s) on the simulation/generation path — these are not correctly-rounded and `
          + `break cross-engine bit-identical replay:\n  ${hits.join("\n  ")}\n`
          + `Use the sqrt-of-squares (or squared-comparison) form instead.`,
      ).toEqual([]);
    }
  });
});
