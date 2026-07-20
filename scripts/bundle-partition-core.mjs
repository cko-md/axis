/**
 * The bundle-budget partition's classification core, extracted so it can be
 * driven behaviorally by src/lib/vector/bundle-partition.test.ts with real
 * adversarial filenames — a grep over check-bundle-budget.mjs's source text
 * could only prove the code LOOKS right, not that "brickrise-extra.abc.js"
 * actually stays in the shared budget.
 *
 * Consumed by scripts/check-bundle-budget.mjs; keep this module free of I/O
 * beyond reading the slug source of truth, and keep the classification rule
 * in one place.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Engine vendor chunks. These names are assigned by dedicated splitChunks
 * cacheGroups in next.config.ts, keyed on the engine's node_modules path, so a
 * chunk can only land here by being deliberately named — never by accident.
 * A closed set: anything else must not be silently excludable.
 */
export const ENGINE_VENDOR_CHUNKS = ["vector-engine-phaser", "vector-engine-three"];

/**
 * Read the game slugs from the single source of truth rather than duplicating
 * them, so a new title cannot silently miss the partition (or, worse, so the
 * list cannot be padded to hide an unrelated regression).
 */
export function readGameSlugs(
  typesSource = path.resolve(process.cwd(), "src/lib/vector/types.ts"),
) {
  const source = readFileSync(typesSource, "utf8");
  const block = source.match(/VECTOR_GAME_SLUGS\s*=\s*\[([\s\S]*?)\]/);
  if (!block) {
    throw new Error("Could not read VECTOR_GAME_SLUGS from src/lib/vector/types.ts");
  }
  return [...block[1].matchAll(/"([a-z0-9-]+)"/g)].map((match) => match[1]);
}

export function routeIsolatedPrefixes(slugs = readGameSlugs()) {
  return [...slugs, ...ENGINE_VENDOR_CHUNKS];
}

/**
 * A chunk is route-isolated only if its filename is exactly `<name>.<hash>.js`
 * (or `<name>.js`) for a known name. Anchoring on the leading segment prevents
 * an unrelated chunk that merely contains a slug substring from drifting out
 * of the aggregate.
 */
export function isRouteIsolatedGameChunk(fileName, prefixes = routeIsolatedPrefixes()) {
  return prefixes.some((name) => fileName === `${name}.js` || fileName.startsWith(`${name}.`));
}
