import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Theme QA guard (NOTES-5): the Notes module + editor must style themselves
// with AXIS design tokens so all four themes (dark/dim/slate/silver-light),
// every font pairing, and every density render coherently. Raw color literals
// are only allowed for pure black/white shadows and scrims (identical in every
// theme); anything else must use a CSS variable. Covers both the component TSX
// and the editor's CSS module.

const NOTES_DIR = join(__dirname);

// black/white with any alpha — shadows, scrims, overlays.
const NEUTRAL_ALPHA = /^rgba\((?:0, ?0, ?0|255, ?255, ?255),[0-9. ]+\)$/;

function colorLiterals(source: string): string[] {
  return (source.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g) ?? []).map((raw) =>
    raw.toLowerCase().replace(/\s+/g, " ").trim(),
  );
}

describe("notes theme QA", () => {
  const files = readdirSync(NOTES_DIR).filter((name) => name.endsWith(".tsx") || name.endsWith(".css"));

  it("scans the notes component + style set", () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
  });

  for (const file of files) {
    it(`${file} styles with design tokens (no raw theme colors)`, () => {
      const source = readFileSync(join(NOTES_DIR, file), "utf8");
      const offenders = colorLiterals(source).filter((literal) => {
        const normalized = literal.replace(/ /g, "");
        return !NEUTRAL_ALPHA.test(normalized);
      });
      expect(offenders, `unexpected raw colors in ${file}; use theme tokens`).toEqual([]);
    });
  }
});
