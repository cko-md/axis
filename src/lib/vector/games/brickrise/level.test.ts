import { describe, expect, it } from "vitest";
import {
  BRICKRISE_LEVEL_CONFIG,
  generateBrickriseLevel,
  hasReachedSummit,
} from "@/lib/vector/games/brickrise/level";
import { boxesOverlap } from "@/lib/vector/games/brickrise/physics";

describe("deterministic generation", () => {
  it("produces an identical tower for the same seed", () => {
    expect(generateBrickriseLevel("seed-a")).toEqual(generateBrickriseLevel("seed-a"));
  });

  it("produces different towers for different seeds", () => {
    const a = generateBrickriseLevel("seed-a");
    const b = generateBrickriseLevel("seed-b");
    expect(a.platforms).not.toEqual(b.platforms);
  });

  // A checkpoint saved in one session is replayed against a tower regenerated
  // in the next. If generation were not byte-stable, a restored checkpoint
  // could place the body inside geometry.
  it("is stable across repeated generation within a session", () => {
    const seeds = ["alpha", "beta", "gamma"];
    for (const seed of seeds) {
      const first = generateBrickriseLevel(seed);
      generateBrickriseLevel("noise-in-between");
      expect(generateBrickriseLevel(seed)).toEqual(first);
    }
  });
});

describe("tower structure", () => {
  const level = generateBrickriseLevel("structure");

  it("starts the player on solid ground", () => {
    const ground = level.platforms.find((p) => p.y === level.height);
    expect(ground).toBeDefined();
    expect(ground!.width).toBe(BRICKRISE_LEVEL_CONFIG.TOWER_WIDTH);
    expect(level.spawn.y).toBe(level.height);
  });

  it("encloses the tower with walls on both sides", () => {
    const left = level.platforms.find((p) => p.x < 0);
    const right = level.platforms.find((p) => p.x >= BRICKRISE_LEVEL_CONFIG.TOWER_WIDTH);
    expect(left).toBeDefined();
    expect(right).toBeDefined();
  });

  it("keeps every climbable platform inside the tower", () => {
    const climbable = level.platforms.filter((p) => p.x >= 0 && p.x < BRICKRISE_LEVEL_CONFIG.TOWER_WIDTH);
    for (const platform of climbable) {
      expect(platform.x).toBeGreaterThanOrEqual(0);
      expect(platform.x + platform.width).toBeLessThanOrEqual(BRICKRISE_LEVEL_CONFIG.TOWER_WIDTH + 0.001);
    }
  });

  it("places the summit above every checkpoint", () => {
    for (const checkpoint of level.checkpoints) {
      // y decreases upward, so the summit must be numerically smaller.
      expect(level.summitY).toBeLessThanOrEqual(checkpoint.y);
    }
  });

  it("issues checkpoints at the configured interval", () => {
    const expected = Math.floor(
      BRICKRISE_LEVEL_CONFIG.FLOOR_COUNT / BRICKRISE_LEVEL_CONFIG.CHECKPOINT_EVERY,
    );
    expect(level.checkpoints).toHaveLength(expected);
    // Indices must be dense and ordered — respawn looks a checkpoint up by index.
    level.checkpoints.forEach((checkpoint, i) => expect(checkpoint.index).toBe(i));
  });
});

describe("fairness invariants", () => {
  // A generated tower that cannot be climbed is unshippable, and it cannot be
  // caught by playtesting one seed. These hold across many seeds.
  const seeds = Array.from({ length: 40 }, (_, i) => `fairness-${i}`);

  it("never places a hazard covering an entire platform", () => {
    for (const seed of seeds) {
      const level = generateBrickriseLevel(seed);
      for (const hazard of level.hazards) {
        const platform = level.platforms.find(
          (p) => Math.abs(p.y - (hazard.y + hazard.height)) < 0.001,
        );
        expect(platform, `${seed}: hazard has no platform beneath it`).toBeDefined();
        // A safe foothold must remain on the same ledge.
        expect(hazard.width).toBeLessThan(platform!.width);
      }
    }
  });

  it("never overlaps two climbable platforms", () => {
    for (const seed of seeds) {
      const level = generateBrickriseLevel(seed);
      const climbable = level.platforms.filter(
        (p) => p.x >= 0 && p.x < BRICKRISE_LEVEL_CONFIG.TOWER_WIDTH && p.y !== level.height,
      );
      for (let i = 0; i < climbable.length; i += 1) {
        for (let j = i + 1; j < climbable.length; j += 1) {
          expect(
            boxesOverlap(climbable[i], climbable[j]),
            `${seed}: platforms ${i} and ${j} overlap`,
          ).toBe(false);
        }
      }
    }
  });

  it("spaces floors consistently so every gap is the same climb", () => {
    for (const seed of seeds.slice(0, 10)) {
      const level = generateBrickriseLevel(seed);
      const ys = [...new Set(level.platforms.filter((p) => p.x >= 0 && p.x < BRICKRISE_LEVEL_CONFIG.TOWER_WIDTH).map((p) => p.y))].sort((a, b) => b - a);
      for (let i = 1; i < ys.length; i += 1) {
        expect(ys[i - 1] - ys[i]).toBe(BRICKRISE_LEVEL_CONFIG.FLOOR_SPACING);
      }
    }
  });
});

describe("hasReachedSummit", () => {
  const level = generateBrickriseLevel("summit");

  it("is false at spawn and true at the summit ledge", () => {
    expect(hasReachedSummit(level, level.spawn.y)).toBe(false);
    expect(hasReachedSummit(level, level.summitY)).toBe(true);
    expect(hasReachedSummit(level, level.summitY - 1)).toBe(true);
  });
});
