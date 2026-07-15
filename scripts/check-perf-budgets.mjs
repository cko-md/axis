#!/usr/bin/env node
/**
 * Performance-budget gate (program §11 / wave 11.2).
 *
 * Parses the route-size table `next build` prints and fails (exit 1) when a
 * measured first-load size exceeds the budgets recorded in
 * .claude/axis-redesign/PERFORMANCE_BUDGETS.json — turning the budgets from a
 * printed report into an enforced CI gate.
 *
 * Usage: node scripts/check-perf-budgets.mjs <build-log-file>
 *        (or pipe:  npm run build | tee build.log && node scripts/check-perf-budgets.mjs build.log)
 */

import { readFileSync } from "node:fs";

const BUDGETS_PATH = ".claude/axis-redesign/PERFORMANCE_BUDGETS.json";

const logPath = process.argv[2];
if (!logPath) {
  console.error("usage: node scripts/check-perf-budgets.mjs <build-log-file>");
  process.exit(2);
}

const budgets = JSON.parse(readFileSync(BUDGETS_PATH, "utf8")).budgets;
const log = readFileSync(logPath, "utf8");

/** Parse a next-build size token like "391 kB" / "1.02 MB" into kB. */
function toKb(value, unit) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return unit === "MB" ? n * 1024 : n;
}

// Route rows look like:  "├ ○ /vitality   12.3 kB   391 kB"  (last size = first-load JS).
const routeRe = /^[├└]\s+[○ƒ●]\s+(\/\S*)\s+.*?([\d.]+)\s+(kB|MB)\s*$/;
// Shared bundle:          "+ First Load JS shared by all   227 kB"
const sharedRe = /First Load JS shared by all\s+([\d.]+)\s+(kB|MB)/;
// Middleware:             "ƒ Middleware   169 kB"
const middlewareRe = /Middleware\s+([\d.]+)\s+(kB|MB)/;

const routes = new Map();
for (const line of log.split("\n")) {
  const m = line.match(routeRe);
  if (m) routes.set(m[1], toKb(m[2], m[3]));
}
const shared = log.match(sharedRe);
const middleware = log.match(middlewareRe);

const failures = [];
const check = (label, measuredKb, budgetKb) => {
  if (measuredKb == null || budgetKb == null) return;
  const line = `${label}: ${Math.round(measuredKb)} kB (budget ${budgetKb} kB)`;
  if (measuredKb > budgetKb) failures.push(line);
  else console.log(`ok  ${line}`);
};

if (routes.size === 0) {
  console.error(`No route table found in ${logPath} — did the build run with output captured?`);
  process.exit(2);
}

check("shared first-load", shared ? toKb(shared[1], shared[2]) : null, budgets.shared_first_load_kb?.budget);
check("middleware", middleware ? toKb(middleware[1], middleware[2]) : null, budgets.middleware_kb?.budget);

const perRouteBudget = budgets.per_route_first_load_kb?.budget;
for (const [route, kb] of routes) {
  const specific = budgets.new_redesign_routes_kb?.[route]?.budget;
  check(route, kb, specific ?? perRouteBudget);
}

if (failures.length > 0) {
  console.error("\nPerformance budget exceeded:");
  for (const f of failures) console.error(`FAIL ${f}`);
  console.error(`\nEither reduce the bundle or consciously raise the budget in ${BUDGETS_PATH} (with justification).`);
  process.exit(1);
}
console.log(`\nAll ${routes.size} routes within budget.`);
