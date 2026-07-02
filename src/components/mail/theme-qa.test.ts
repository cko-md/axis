import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Theme QA guard: Mail UI must style itself with AXIS design tokens so all
// four themes (Dark/Dim/Slate/Light) work. Raw color literals are allowed
// only for documented exceptions:
//   1. provider brand identity (Gmail red / Outlook blue),
//   2. the fixed light "paper" palette HTML email is authored against,
//   3. pure-black shadows/scrims (black in every theme).
// Anything else fails this test and should use a CSS variable instead.

const MAIL_DIR = join(__dirname);

const ALLOWED_EXACT = new Set(
  [
    // provider brand colors
    "#ea4335",
    "#0078d4",
    "rgba(234,67,53,0.15)",
    "rgba(234,67,53,0.3)",
    "rgba(234,67,53,0.12)",
    "rgba(0,120,212,0.15)",
    "rgba(0,120,212,0.3)",
    "rgba(0,120,212,0.12)",
    // paper palette (defined once as --mail-paper-* custom properties)
    "#fbfaf7",
    "#1c1a16",
    "#1d4ed8",
    "#d5cfc2",
    "#5c574d",
  ].map((value) => value.toLowerCase()),
);

// Pure black with any alpha — shadows and modal scrims.
const BLACK_ALPHA = /^rgba\(0,0,0,[0-9.]+\)$/;

function colorLiterals(source: string): string[] {
  return (source.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g) ?? []).map((raw) =>
    raw.toLowerCase().replace(/\s+/g, ""),
  );
}

describe("mail theme QA", () => {
  const files = readdirSync(MAIL_DIR).filter((name) => name.endsWith(".tsx"));

  it("scans the mail component set", () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  for (const file of files) {
    it(`${file} uses design tokens outside the documented palette`, () => {
      const source = readFileSync(join(MAIL_DIR, file), "utf8");
      const offenders = colorLiterals(source).filter(
        (literal) => !ALLOWED_EXACT.has(literal) && !BLACK_ALPHA.test(literal),
      );
      expect(offenders, `unexpected raw colors in ${file}; use theme tokens`).toEqual([]);
    });
  }
});
