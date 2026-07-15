#!/usr/bin/env node
/**
 * Deterministic bundle-budget gate (program §11, §20). Sums the on-disk JS in
 * `.next/static/chunks` after a build and fails if it exceeds the budget in
 * `.claude/axis-redesign/PERFORMANCE_BUDGETS.json`. Reading file sizes (not
 * parsing the build log) keeps this robust and non-flaky.
 *
 * Usage: `node scripts/check-bundle-budget.mjs` (run after `next build`).
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";

const CHUNKS_DIR = path.resolve(process.cwd(), ".next/static/chunks");
const BUDGETS = path.resolve(process.cwd(), ".claude/axis-redesign/PERFORMANCE_BUDGETS.json");

function walkJsSize(dir) {
  let bytes = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) bytes += walkJsSize(full);
    else if (entry.isFile() && entry.name.endsWith(".js")) bytes += statSync(full).size;
  }
  return bytes;
}

if (!existsSync(CHUNKS_DIR)) {
  console.error(`✗ ${CHUNKS_DIR} not found — run \`next build\` first.`);
  process.exit(2);
}

const budgetKb = JSON.parse(readFileSync(BUDGETS, "utf8"))?.budgets?.total_static_js_kb?.budget;
if (typeof budgetKb !== "number") {
  console.error("✗ Missing budgets.total_static_js_kb.budget in PERFORMANCE_BUDGETS.json");
  process.exit(2);
}

const totalKb = Math.round(walkJsSize(CHUNKS_DIR) / 1024);
const pct = ((totalKb / budgetKb) * 100).toFixed(1);

if (totalKb > budgetKb) {
  console.error(`✗ Bundle over budget: ${totalKb} KB of static JS > ${budgetKb} KB budget (${pct}%).`);
  console.error("  Investigate a bundle regression, or raise the budget deliberately in PERFORMANCE_BUDGETS.json.");
  process.exit(1);
}

console.log(`✓ Bundle within budget: ${totalKb} KB / ${budgetKb} KB (${pct}%).`);
