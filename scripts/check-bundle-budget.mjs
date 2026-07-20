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
import { routeIsolatedPrefixes, isRouteIsolatedGameChunk } from "./bundle-partition-core.mjs";

const CHUNKS_DIR = path.resolve(process.cwd(), ".next/static/chunks");
const BUDGETS = path.resolve(process.cwd(), ".claude/axis-redesign/PERFORMANCE_BUDGETS.json");

/*
 * The classification rule — which filenames count as route-isolated, the
 * engine-vendor chunk names (assigned by next.config.ts cacheGroups, never by
 * webpackChunkName magic comments — the two cancel each other out; see
 * src/lib/vector/engine-chunks.test.ts), and the slug list derived from
 * src/lib/vector/types.ts — lives in bundle-partition-core.mjs so the
 * partition tests can drive it with real adversarial filenames instead of
 * grepping this script's text.
 */
let ROUTE_ISOLATED_PREFIXES;
try {
  ROUTE_ISOLATED_PREFIXES = routeIsolatedPrefixes();
} catch (error) {
  console.error(`✗ ${error.message}`);
  process.exit(2);
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
      if (isRouteIsolatedGameChunk(entry.name, ROUTE_ISOLATED_PREFIXES)) {
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

/**
 * The partition is only sound if the excluded chunks really are route-isolated:
 * a chunk billed to the game budget while some shared route actually loads it
 * would understate the shared bundle by exactly that chunk's size. The commit
 * that introduced the partition verified this by hand once; this re-derives it
 * from the build output every run, so an eager import added to a layout or nav
 * widget fails the gate instead of slipping into the looser game budget.
 */
function assertRouteIsolation(isolatedFiles) {
  const manifestPath = path.resolve(process.cwd(), ".next/app-build-manifest.json");
  if (!existsSync(manifestPath)) {
    console.error(`✗ ${manifestPath} not found — run \`next build\` first.`);
    process.exit(2);
  }
  const pages = JSON.parse(readFileSync(manifestPath, "utf8"))?.pages ?? {};
  const offenders = [];
  for (const file of isolatedFiles) {
    for (const [route, entries] of Object.entries(pages)) {
      if (entries.some((entry) => entry.endsWith(`/${file.name}`) || entry === `static/chunks/${file.name}`)) {
        offenders.push(`${file.name} is loaded by route ${route}`);
      }
    }
  }
  if (offenders.length > 0) {
    console.error("✗ Chunks billed to the route-isolated game budget are reachable from routes:");
    for (const line of offenders) console.error(`    ${line}`);
    console.error("  A route-loaded chunk belongs in the shared budget; fix the import graph.");
    process.exit(1);
  }
  console.log(`✓ Route isolation verified: ${isolatedFiles.length} game chunk(s) in 0 of ${Object.keys(pages).length} route entries.`);
}

const { shared, routeIsolated, isolatedFiles } = walkJsSize(CHUNKS_DIR);
assertRouteIsolation(isolatedFiles);
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
