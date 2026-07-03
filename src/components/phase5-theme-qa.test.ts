import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Phase 5 rendering/theme QA guard (OBJ-4 / DEBRIEF-5 / PIPE-5 / LIT-5).
// The beta planning/research modules must style themselves with AXIS design
// tokens so all four themes — including the silver/chrome light theme, where
// hardcoded darks are the usual failure — render coherently. Raw color
// literals are only allowed for pure black/white shadows and scrims (identical
// across every theme); anything else must use a CSS variable. This locks in
// the modules' currently-clean state and fails CI on any regression, the same
// guard already protecting Mail (mail/theme-qa) and Notes (notes/theme-qa).

const MODULE_DIRS = ["objectives", "debrief", "pipeline", "literature"] as const;

// black/white with any alpha — shadows, scrims, overlays.
const NEUTRAL_ALPHA = /^rgba\((?:0,0,0|255,255,255),[0-9.]+\)$/;

function colorLiterals(source: string): string[] {
  // Strip `var(--token, #fallback)` first: a design-token reference with a
  // defensive literal fallback is theme-safe (the token always wins at
  // runtime), so its fallback hex/rgb must not count as a raw color.
  const withoutVarFallbacks = source.replace(/var\(\s*--[^)]*\)/g, "var()");
  return (withoutVarFallbacks.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g) ?? []).map((raw) =>
    raw.toLowerCase().replace(/\s+/g, ""),
  );
}

describe("Phase 5 module theme QA", () => {
  for (const dir of MODULE_DIRS) {
    const moduleDir = join(__dirname, dir);
    const files = readdirSync(moduleDir).filter((name) => name.endsWith(".tsx") || name.endsWith(".css"));

    it(`${dir}: has component files to scan`, () => {
      expect(files.length).toBeGreaterThan(0);
    });

    for (const file of files) {
      it(`${dir}/${file}: styles with design tokens (no raw theme colors)`, () => {
        const source = readFileSync(join(moduleDir, file), "utf8");
        const offenders = colorLiterals(source).filter((literal) => !NEUTRAL_ALPHA.test(literal));
        expect(offenders, `unexpected raw colors in ${dir}/${file}; use theme tokens`).toEqual([]);
      });
    }
  }
});
