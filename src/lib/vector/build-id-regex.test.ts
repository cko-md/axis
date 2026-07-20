import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The Next.js build-id validation regex is duplicated across three files that
 * cannot share a module cleanly (a build-time .mjs script and two bundled TS
 * modules). Duplicated constants drift — that is precisely how the original bug
 * shipped in three places at once and how a fix could later be applied to only
 * one. This guard keeps the three byte-identical.
 *
 * The pattern must accept a leading `_` or `-` (Next's nanoid alphabet is
 * [A-Za-z0-9_-]) and must NOT accept a leading `.` (build ids are interpolated
 * into filenames and cache keys; a leading dot admits the "." / ".." family).
 */
const CANONICAL = String.raw`/^[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,159}$/`;

const FILES = [
  "scripts/generate-vector-offline-manifests.mjs",
  "src/lib/vector/offline-deployment.ts",
  "src/lib/vector/offline.ts",
];

describe("build-id validation regex", () => {
  it("is identical across every copy", () => {
    for (const file of FILES) {
      const source = readFileSync(path.join(process.cwd(), file), "utf8");
      expect(
        source.includes(`const BUILD_ID = ${CANONICAL};`),
        `${file} does not carry the canonical BUILD_ID regex ${CANONICAL}`,
      ).toBe(true);
    }
  });

  it("behaves as specified", () => {
    const pattern = new RegExp(CANONICAL.slice(1, -1));
    // Real Next build ids, including the alphabet edges that broke before.
    for (const ok of ["_0wHbfAf7F4d-vWhbJcxS", "-1miKLG-szMdLptZDnh-Y", "build-1", "_", "A"]) {
      expect(pattern.test(ok), `"${ok}" should pass`).toBe(true);
    }
    // Leading dot, path separators, and over-length are rejected.
    for (const bad of [".hidden", "..", ".", "a/b", "", "x".repeat(161)]) {
      expect(pattern.test(bad), `"${bad}" should fail`).toBe(false);
    }
    // The cap admits exactly 160 characters.
    expect(pattern.test("a".repeat(160))).toBe(true);
  });
});
