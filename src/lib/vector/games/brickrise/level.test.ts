import { describe, expect, it } from "vitest";
import {
  BRICKRISE_CHECKPOINT_TRIGGER,
  BRICKRISE_LEVEL_CONFIG,
  checkpointTriggerBox,
  generateBrickriseLevel,
  hasReachedSummit,
} from "@/lib/vector/games/brickrise/level";
import {
  BRICKRISE_PHYSICS,
  INITIAL_BODY_STATE,
  boxesOverlap,
  placeBodyAt,
} from "@/lib/vector/games/brickrise/physics";

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

  it("issues checkpoints at the configured interval, excluding the summit", () => {
    const onInterval = Math.floor(
      BRICKRISE_LEVEL_CONFIG.FLOOR_COUNT / BRICKRISE_LEVEL_CONFIG.CHECKPOINT_EVERY,
    );
    // The summit floor lands on the interval but carries no checkpoint.
    const summitOnInterval =
      BRICKRISE_LEVEL_CONFIG.FLOOR_COUNT % BRICKRISE_LEVEL_CONFIG.CHECKPOINT_EVERY === 0 ? 1 : 0;
    expect(level.checkpoints).toHaveLength(onInterval - summitOnInterval);
    // Indices must be dense and ordered — respawn looks a checkpoint up by index.
    level.checkpoints.forEach((checkpoint, i) => expect(checkpoint.index).toBe(i));
  });

  it("never places a checkpoint on the summit ledge", () => {
    // A checkpoint there is unreachable-by-respawn dead state, and it would
    // fire a checkpoint event on the same step the run completes.
    for (const seed of ["summit-cp-a", "summit-cp-b", "summit-cp-c"]) {
      const tower = generateBrickriseLevel(seed);
      for (const checkpoint of tower.checkpoints) {
        expect(checkpoint.y, `${seed}: checkpoint ${checkpoint.index} sits on the summit`)
          .toBeGreaterThan(tower.summitY);
      }
    }
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

describe("checkpointTriggerBox", () => {
  const checkpoint = { index: 0, x: 300, y: 500 };

  it("is centred on the checkpoint and sits on its ledge", () => {
    const box = checkpointTriggerBox(checkpoint);

    expect(box.x + box.width / 2).toBe(checkpoint.x);
    // Bottom edge rests on the ledge surface; the volume extends upward only.
    expect(box.y + box.height).toBe(checkpoint.y);
  });

  it("catches a body standing anywhere on the checkpoint's footing", () => {
    const box = checkpointTriggerBox(checkpoint);

    for (const offset of [-24, -12, 0, 12, 24]) {
      const body = placeBodyAt(INITIAL_BODY_STATE, checkpoint.x + offset, checkpoint.y);
      expect(boxesOverlap(body.box, box), `offset ${offset} missed the trigger`).toBe(true);
    }
  });

  it("cannot be tunnelled through at full running speed", () => {
    // The body advances at most MAX_RUN_SPEED per fixed step. If that is ever
    // larger than the combined trigger + body width, a fast pass could step
    // straight over the volume without a single overlapping frame.
    const widest = BRICKRISE_CHECKPOINT_TRIGGER.WIDTH + INITIAL_BODY_STATE.box.width;
    expect(BRICKRISE_PHYSICS.MAX_RUN_SPEED).toBeLessThan(widest);
  });

  it("does not bank a checkpoint sailed over well above the ledge", () => {
    const box = checkpointTriggerBox(checkpoint);
    // A body whose feet clear the trigger's top edge entirely.
    const body = placeBodyAt(
      INITIAL_BODY_STATE,
      checkpoint.x,
      checkpoint.y - BRICKRISE_CHECKPOINT_TRIGGER.HEIGHT - 1,
    );

    expect(boxesOverlap(body.box, box)).toBe(false);
  });

  it("covers every generated checkpoint without leaving the tower", () => {
    const level = generateBrickriseLevel("trigger-coverage");

    for (const point of level.checkpoints) {
      const box = checkpointTriggerBox(point);
      expect(box.width).toBe(BRICKRISE_CHECKPOINT_TRIGGER.WIDTH);
      // A trigger hanging outside the walls would be unreachable.
      expect(box.x).toBeGreaterThanOrEqual(-BRICKRISE_LEVEL_CONFIG.WALL_THICKNESS);
      expect(box.x + box.width).toBeLessThanOrEqual(
        BRICKRISE_LEVEL_CONFIG.TOWER_WIDTH + BRICKRISE_LEVEL_CONFIG.WALL_THICKNESS,
      );
    }
  });
});
