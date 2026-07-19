import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards the VECTOR game-engine chunk naming, which has one silent failure mode
 * that costs a whole wave to rediscover.
 *
 * scripts/check-bundle-budget.mjs bills a chunk to the route-isolated game
 * budget by FILENAME. An engine therefore has to land in a chunk literally named
 * `vector-engine-phaser` / `vector-engine-three`. There are two ways to ask for
 * that name and they are mutually destructive:
 *
 *   - a splitChunks cacheGroup in next.config.ts (what we use), and
 *   - a `webpackChunkName` magic comment at the import site.
 *
 * Using BOTH produces neither. The magic comment pre-registers the name in
 * `compilation.namedChunks`; SplitChunksPlugin's existing-chunk guard then sees
 * that chunk is not a parent of the selected chunks and drops the cacheGroup
 * entry with no warning. Phaser falls through to Next's `lib` group, gets a hash
 * name, and ~1.1 MB is misfiled into the SHARED budget — which reads as a
 * catastrophic bundle regression on a route no non-player ever loads.
 *
 * The build is the only place that proves the emitted filename, and CI runs it.
 * These tests hold the source-level contract that makes the build succeed.
 */

const REPO_ROOT = process.cwd();

function read(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

/**
 * Production source only. Tests are excluded deliberately: the contract is
 * about what the bundler compiles, and a spec file that merely *describes* the
 * forbidden pairing (this one does) is not a violation of it.
 */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true })) {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(relative, acc);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) acc.push(relative);
  }
  return acc;
}

/** The engine packages the budget script knows how to bill separately. */
const ENGINES = [
  { pkg: "phaser", chunk: "vector-engine-phaser" },
  { pkg: "three", chunk: "vector-engine-three" },
] as const;

/**
 * `import( <anything, incl. comments> "phaser<optional subpath>" )`
 *
 * Subpaths are matched too: `import("phaser/src/core/Game")` resolves through
 * the same node_modules path the cacheGroup tests, so a magic comment on a
 * subpath import would defeat the naming exactly as a bare one does.
 *
 * `typeof import("phaser")` is excluded — that is a type-only position, erased
 * before the bundler sees it, and this file itself uses one.
 */
const ENGINE_IMPORT = /(?<!typeof\s)import\(([^)]*?)["'](phaser|three)(?:\/[^"']*)?["']\s*\)/g;

describe("VECTOR engine chunk naming", () => {
  const nextConfig = read("next.config.ts");
  const budgetScript = read("scripts/check-bundle-budget.mjs");

  it("declares a cacheGroup for every chunk name the budget script excludes", () => {
    for (const engine of ENGINES) {
      expect(
        budgetScript.includes(`"${engine.chunk}"`),
        `check-bundle-budget.mjs no longer excludes ${engine.chunk}`,
      ).toBe(true);
      expect(
        nextConfig.includes(`name: "${engine.chunk}"`),
        `next.config.ts declares no cacheGroup naming ${engine.chunk}`,
      ).toBe(true);
    }
  });

  it("targets each engine's own node_modules path", () => {
    for (const engine of ENGINES) {
      expect(
        new RegExp(`node_modules\\[\\\\\\\\/\\]${engine.pkg}\\[`).test(nextConfig),
        `next.config.ts has no cacheGroup test matching node_modules/${engine.pkg}`,
      ).toBe(true);
    }
  });

  it("outranks Next's own framework and lib cacheGroups", () => {
    // Next names `lib` at priority 30 and `framework` at 40. A group at or below
    // those loses the module and the engine gets hash-named again.
    //
    // Scoped to the vectorEngine* blocks specifically: asserting over every
    // `priority:` in the file would break the moment an unrelated cacheGroup
    // with a legitimately lower priority is added.
    for (const group of ["vectorEnginePhaser", "vectorEngineThree"]) {
      const block = nextConfig.match(new RegExp(`${group}:\\s*\\{[^}]*\\}`));
      expect(block, `next.config.ts has no ${group} cacheGroup`).not.toBeNull();
      const priority = block![0].match(/priority:\s*(\d+)/);
      expect(priority, `${group} declares no priority`).not.toBeNull();
      expect(Number(priority![1])).toBeGreaterThan(40);
    }
  });

  it("never pairs an engine import with a webpackChunkName magic comment", () => {
    // This is the regression that silently costs the shared budget ~1.1 MB.
    const offenders: string[] = [];
    for (const file of sourceFiles("src")) {
      const contents = read(file);
      for (const match of contents.matchAll(ENGINE_IMPORT)) {
        if (match[1].includes("webpackChunkName")) {
          offenders.push(`${file}: import("${match[2]}") carries a webpackChunkName comment`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("imports Phaser exactly once, from the Brickrise shell", () => {
    // A second import site would split the engine across chunks, and one of
    // them would not be covered by the cacheGroup's name.
    const importers = sourceFiles("src").filter((file) => {
      const contents = read(file);
      return [...contents.matchAll(ENGINE_IMPORT)].some((match) => match[2] === "phaser");
    });

    expect(importers).toEqual(["src/lib/vector/games/brickrise/game.ts"]);
  });

  it("imports Three exactly once, from the Paper Glider shell", () => {
    // Same rule as Phaser above: one import site, or the engine splits across
    // chunks and part of it escapes the cacheGroup's name.
    const importers = sourceFiles("src").filter((file) => {
      const contents = read(file);
      return [...contents.matchAll(ENGINE_IMPORT)].some((match) => match[2] === "three");
    });

    expect(importers).toEqual(["src/lib/vector/games/paper-glider/game.ts"]);
  });
});
