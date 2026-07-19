#!/usr/bin/env node
/**
 * Deterministic bundle-budget gate (program §11, §20). Sums the on-disk JS in
 * `.next/static/chunks` after a build and fails if it exceeds the budget in
 * `.claude/axis-redesign/PERFORMANCE_BUDGETS.json`. Reading file sizes (not
 * parsing the build log) keeps this robust and non-flaky.
 *
 * ── Route-isolated VECTOR game chunks are budgeted separately ────────────────
 * Owner decision, 2026-07-19. A dynamically imported game chunk is downloaded
 * only by someone who opens that specific game; it is never part of any other
 * route's payload. Counting it in the same total as the shared application
 * bundle measured deploy size rather than what a user actually pays, and made
 * every remaining game wave unshippable (Phaser alone is ~1168 kB against
 * 143 kB of headroom).
 *
 * This is a re-partition, NOT an exemption:
 *
 *  - The excluded set is explicit and closed. Only chunks whose filename
 *    matches a slug in VECTOR_GAME_SLUGS, or a declared engine-vendor chunk
 *    name, are moved out. Anything else — including an accidental regression
 *    in shared code — still counts against the aggregate and still fails here.
 *  - The excluded bytes get their own enforced budget
 *    (`route_isolated_game_js_kb`), so they are bounded, not unlimited.
 *  - Both figures are always printed, so the total remains visible.
 *
 * Per-route first-load budgets (scripts/check-perf-budgets.mjs, 420 kB/route)
 * are unchanged and remain the gate that governs what a user downloads.
 *
 * Usage: `node scripts/check-bundle-budget.mjs` (run after `next build`).
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";

const CHUNKS_DIR = path.resolve(process.cwd(), ".next/static/chunks");
const BUDGETS = path.resolve(process.cwd(), ".claude/axis-redesign/PERFORMANCE_BUDGETS.json");

const TYPES_SOURCE = path.resolve(process.cwd(), "src/lib/vector/types.ts");

/**
 * Engine vendor chunks. These names are asserted by an explicit
 * `webpackChunkName` magic comment at the import site, so a chunk can only land
 * here by being deliberately named — never by accident.
 */
const ENGINE_VENDOR_CHUNKS = ["vector-engine-phaser", "vector-engine-three"];

/**
 * Read the game slugs from the single source of truth rather than duplicating
 * them, so a new title cannot silently miss the partition (or, worse, so this
 * list cannot be padded to hide an unrelated regression).
 */
function readGameSlugs() {
  const source = readFileSync(TYPES_SOURCE, "utf8");
  const block = source.match(/VECTOR_GAME_SLUGS\s*=\s*\[([\s\S]*?)\]/);
  if (!block) {
    console.error("✗ Could not read VECTOR_GAME_SLUGS from src/lib/vector/types.ts");
    process.exit(2);
  }
  return [...block[1].matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]);
}

const ROUTE_ISOLATED_PREFIXES = [...readGameSlugs(), ...ENGINE_VENDOR_CHUNKS];

/**
 * A chunk is route-isolated only if its filename is exactly `<name>.<hash>.js`
 * for a known name. Anchoring on the leading segment prevents an unrelated
 * chunk that merely contains a slug substring from drifting out of the
 * aggregate.
 */
function isRouteIsolatedGameChunk(fileName) {
  return ROUTE_ISOLATED_PREFIXES.some(
    (name) => fileName === `${name}.js` || fileName.startsWith(`${name}.`),
  );
}

function walkJsSize(dir) {
  let shared = 0;
  let routeIsolated = 0;
  const isolatedFiles = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = walkJsSize(full);
      shared += nested.shared;
      routeIsolated += nested.routeIsolated;
      isolatedFiles.push(...nested.isolatedFiles);
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      const size = statSync(full).size;
      if (isRouteIsolatedGameChunk(entry.name)) {
        routeIsolated += size;
        isolatedFiles.push({ name: entry.name, size });
      } else {
        shared += size;
      }
    }
  }
  return { shared, routeIsolated, isolatedFiles };
}

if (!existsSync(CHUNKS_DIR)) {
  console.error(`✗ ${CHUNKS_DIR} not found — run \`next build\` first.`);
  process.exit(2);
}

const budgets = JSON.parse(readFileSync(BUDGETS, "utf8"))?.budgets;
const budgetKb = budgets?.total_static_js_kb?.budget;
const gameBudgetKb = budgets?.route_isolated_game_js_kb?.budget;
if (typeof budgetKb !== "number") {
  console.error("✗ Missing budgets.total_static_js_kb.budget in PERFORMANCE_BUDGETS.json");
  process.exit(2);
}
if (typeof gameBudgetKb !== "number") {
  console.error("✗ Missing budgets.route_isolated_game_js_kb.budget in PERFORMANCE_BUDGETS.json");
  process.exit(2);
}

const { shared, routeIsolated, isolatedFiles } = walkJsSize(CHUNKS_DIR);
const sharedKb = Math.round(shared / 1024);
const gameKb = Math.round(routeIsolated / 1024);
const combinedKb = sharedKb + gameKb;
const pct = ((sharedKb / budgetKb) * 100).toFixed(1);
const gamePct = ((gameKb / gameBudgetKb) * 100).toFixed(1);

// Always report the partition, so excluding bytes can never quietly hide them.
if (isolatedFiles.length > 0) {
  console.log(`Route-isolated VECTOR game chunks (${isolatedFiles.length}):`);
  for (const file of isolatedFiles.sort((a, b) => b.size - a.size)) {
    console.log(`  ${String(Math.round(file.size / 1024)).padStart(6)} KB  ${file.name}`);
  }
}

let failed = false;
if (sharedKb > budgetKb) {
  console.error(`✗ Shared bundle over budget: ${sharedKb} KB > ${budgetKb} KB (${pct}%).`);
  console.error("  Investigate a bundle regression, or raise the budget deliberately in PERFORMANCE_BUDGETS.json.");
  failed = true;
}
if (gameKb > gameBudgetKb) {
  console.error(`✗ Route-isolated game chunks over budget: ${gameKb} KB > ${gameBudgetKb} KB (${gamePct}%).`);
  console.error("  Game chunks are budgeted separately, not exempt.");
  failed = true;
}
if (failed) process.exit(1);

console.log(`✓ Shared bundle within budget: ${sharedKb} KB / ${budgetKb} KB (${pct}%).`);
console.log(`✓ Route-isolated game chunks within budget: ${gameKb} KB / ${gameBudgetKb} KB (${gamePct}%).`);
console.log(`  Combined static JS: ${combinedKb} KB.`);
