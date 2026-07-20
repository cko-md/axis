import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { VECTOR_GAME_SLUGS } from "@/lib/vector/types";
import {
  ENGINE_VENDOR_CHUNKS,
  isRouteIsolatedGameChunk,
  readGameSlugs,
  routeIsolatedPrefixes,
} from "../../../scripts/bundle-partition-core.mjs";

/**
 * Guards the bundle-budget partition (owner decision 2026-07-19).
 *
 * Route-isolated VECTOR game chunks are budgeted separately from the shared
 * application bundle, because a dynamically imported game chunk is downloaded
 * only by someone who opens that game and is never part of another route's
 * payload. That is a defensible re-partition — but it is one edit away from
 * becoming a loophole that hides an unrelated bundle regression.
 *
 * The classification rule itself lives in scripts/bundle-partition-core.mjs
 * and is exercised HERE with real filenames — including the adversarial ones —
 * rather than by grepping the budget script's source text. The remaining
 * source-level assertions pin only what cannot be executed from vitest: the
 * script's enforcement and reporting behavior after a build.
 */

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

const SCRIPT = "scripts/check-bundle-budget.mjs";
const CORE = "scripts/bundle-partition-core.mjs";

describe("bundle partition classification (behavioral)", () => {
  const prefixes = routeIsolatedPrefixes();

  it("derives the slug set from VECTOR_GAME_SLUGS in types.ts, not a copy", () => {
    // readGameSlugs parses the same source module this test imports, so any
    // drift between the two is impossible by construction — and a hardcoded
    // slug in the core module would still be caught by the grep below.
    expect(readGameSlugs()).toEqual([...VECTOR_GAME_SLUGS]);
    const core = read(CORE);
    for (const slug of VECTOR_GAME_SLUGS) {
      expect(
        new RegExp(`["']${slug}["']`).test(core),
        `${CORE} hardcodes the slug "${slug}" instead of reading it from types.ts`,
      ).toBe(false);
    }
  });

  it("keeps engine vendor chunks a closed, explicitly named set", () => {
    expect(ENGINE_VENDOR_CHUNKS).toEqual(["vector-engine-phaser", "vector-engine-three"]);
  });

  it("classifies real game and engine chunk filenames as route-isolated", () => {
    for (const name of [
      "second-sense.7abcc60968a16938.js",
      "brickrise.80ff92a41ff849d4.js",
      "paper-glider.36b7a442d66cbbe2.js",
      // Slugs with no shipped chunk yet must classify the day their chunk
      // first appears — the set is derived, not maintained.
      "time-to-fly.0123456789abcdef.js",
      "vector-engine-phaser.a57054ea7db1d2cf.js",
      "vector-engine-three.e809941dab366374.js",
      // Nameless-hash suffix form and bare name.js both anchor correctly.
      "brickrise.js",
    ]) {
      expect(isRouteIsolatedGameChunk(name, prefixes), `${name} must be route-isolated`).toBe(true);
    }
  });

  it("keeps adversarial and unrelated filenames in the shared budget", () => {
    for (const name of [
      // Slug-prefixed but a DIFFERENT chunk: the anchoring property.
      "brickrise-extra.abc123.js",
      "second-sense-widget.abc123.js",
      "vector-engine-phaser-vendor.abc123.js",
      // Slug embedded mid-name.
      "shared-brickrise.abc123.js",
      "xbrickrise.abc123.js",
      // Ordinary Next.js chunks: hash-only, framework, main.
      "4a2b6c8d.js",
      "framework-64ad27b21261a9ce.js",
      "main-app-abc123.js",
      // A bare slug with no .js extension is not a chunk filename.
      "brickrise",
    ]) {
      expect(isRouteIsolatedGameChunk(name, prefixes), `${name} must stay shared`).toBe(false);
    }
  });

  it("fails loudly when the slug source of truth is unreadable", () => {
    expect(() => readGameSlugs(path.join(process.cwd(), "package.json"))).toThrow(
      /VECTOR_GAME_SLUGS/,
    );
  });
});

describe("bundle budget script behavior (source-level)", () => {
  // The script itself needs a completed `next build` to run, so its
  // enforcement and reporting are pinned at the source level here and proven
  // live by CI, which runs it after the build.

  it("consumes the shared classification core", () => {
    const source = read(SCRIPT);
    expect(source).toMatch(/from "\.\/bundle-partition-core\.mjs"/);
    expect(source).toMatch(/isRouteIsolatedGameChunk\(entry\.name, ROUTE_ISOLATED_PREFIXES\)/);
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

  it("verifies route isolation against the build manifest", () => {
    // Filename classification alone cannot prove a chunk is unreachable from
    // shared routes; the script must re-derive that from app-build-manifest.
    const source = read(SCRIPT);
    expect(source).toMatch(/app-build-manifest\.json/);
    expect(source).toMatch(/assertRouteIsolation\(isolatedFiles\)/);
  });

  it("reports the excluded chunks instead of dropping them silently", () => {
    const source = read(SCRIPT);
    expect(source).toMatch(/Route-isolated VECTOR game chunks/);
    expect(source).toMatch(/Combined static JS/);
  });
});
