import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { VECTOR_GAME_SLUGS } from "@/lib/vector/types";

/**
 * Guards the bundle-budget partition (owner decision 2026-07-19).
 *
 * Route-isolated VECTOR game chunks are budgeted separately from the shared
 * application bundle, because a dynamically imported game chunk is downloaded
 * only by someone who opens that game and is never part of another route's
 * payload. That is a defensible re-partition — but it is one edit away from
 * becoming a loophole that hides an unrelated bundle regression.
 *
 * These tests assert the properties that keep it honest:
 *   1. the excluded set is derived from the single source of truth, not a
 *      hand-maintained list that could be padded;
 *   2. engine vendor chunks are a closed, explicitly-named set;
 *   3. the excluded bytes are themselves budgeted and enforced;
 *   4. both figures are reported, so nothing is silently dropped.
 */

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

const SCRIPT = "scripts/check-bundle-budget.mjs";

describe("bundle budget partition", () => {
  it("derives the excluded slugs from VECTOR_GAME_SLUGS rather than duplicating them", () => {
    const source = read(SCRIPT);
    expect(source).toMatch(/VECTOR_GAME_SLUGS/);
    expect(source).toMatch(/src\/lib\/vector\/types\.ts/);

    // A hardcoded slug array in the script would mean the two can drift, and
    // would let the excluded set be widened without touching the registry.
    for (const slug of VECTOR_GAME_SLUGS) {
      expect(
        new RegExp(`["']${slug}["']`).test(source),
        `${SCRIPT} hardcodes the slug "${slug}" instead of reading it from types.ts`,
      ).toBe(false);
    }
  });

  it("keeps engine vendor chunks a closed, explicitly named set", () => {
    const source = read(SCRIPT);
    expect(source).toMatch(/ENGINE_VENDOR_CHUNKS\s*=\s*\[/);
    // Only these two engines exist in the contract; anything else must not be
    // silently excludable.
    expect(source).toMatch(/vector-engine-phaser/);
    expect(source).toMatch(/vector-engine-three/);
  });

  it("enforces a separate budget on the excluded bytes", () => {
    const source = read(SCRIPT);
    // Excluded must mean "budgeted elsewhere", never "unbounded".
    expect(source).toMatch(/route_isolated_game_js_kb/);
    expect(source).toMatch(/gameKb > gameBudgetKb/);

    const budgets = JSON.parse(read(".claude/axis-redesign/PERFORMANCE_BUDGETS.json"));
    expect(typeof budgets.budgets.route_isolated_game_js_kb.budget).toBe("number");
    expect(budgets.budgets.route_isolated_game_js_kb.budget).toBeGreaterThan(0);
  });

  it("still fails the shared bundle on a regression", () => {
    const source = read(SCRIPT);
    expect(source).toMatch(/sharedKb > budgetKb/);
    expect(source).toMatch(/process\.exit\(1\)/);
  });

  it("reports the excluded chunks instead of dropping them silently", () => {
    const source = read(SCRIPT);
    expect(source).toMatch(/Route-isolated VECTOR game chunks/);
    expect(source).toMatch(/Combined static JS/);
  });

  it("anchors matching to the leading filename segment", () => {
    // Substring matching would let an unrelated chunk that merely contains a
    // slug drift out of the aggregate.
    const source = read(SCRIPT);
    expect(source).toMatch(/startsWith\(`\$\{name\}\.`\)/);
  });
});
