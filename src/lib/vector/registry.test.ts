import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  getVectorLoaderEngines,
  loadVectorGame,
  VECTOR_GAME_LOADERS,
  VectorGameLoaderUnavailableError,
} from "@/lib/vector/loaders";
import {
  VECTOR_GAME_REGISTRY,
  getVectorGame,
  getVectorRegistryIssues,
  requireVectorGame,
} from "@/lib/vector/registry";
import { VECTOR_GAME_SLUGS, type VectorGameManifest } from "@/lib/vector/types";

describe("VECTOR game registry", () => {
  it("contains the complete catalog in binding build order", () => {
    expect(VECTOR_GAME_REGISTRY.map((game) => game.slug)).toEqual([...VECTOR_GAME_SLUGS]);
    expect(VECTOR_GAME_REGISTRY).toHaveLength(9);
  });

  it("keeps every remaining game honestly planned and disabled after Wave 15.3", () => {
    expect(Object.keys(VECTOR_GAME_LOADERS)).toEqual(["second-sense"]);
    for (const game of VECTOR_GAME_REGISTRY) {
      if (game.slug === "second-sense") continue;
      expect(game.status).toBe("planned");
      expect(game.version).toBe("0.0.0");
      expect(game.cover.status).toBe("planned");
      expect(game.preview.status).toBe("planned");
      expect(game.offline.available).toBe(false);
      expect(game.offline.assetIds).toEqual([]);
      expect(game.loaderKey).toBe(game.id);
      expect(game.audio.available).toBe(false);
      expect(game.audio.channels).toEqual([]);
      expect(game.availabilityReason).toMatch(/planned/i);
    }
  });

  it("ships Second Sense as the first complete, available VECTOR title (Wave 15.3)", () => {
    const secondSense = getVectorGame("second-sense");
    expect(secondSense?.status).toBe("available");
    expect(secondSense?.version).toBe("1.0.0");
    expect(secondSense?.loaderKey).toBe("second-sense");
    expect(secondSense?.engine).toBe("native");
    expect(secondSense?.cover.status).toBe("ready");
    expect(secondSense?.preview.status).toBe("ready");
    expect(secondSense?.offline.available).toBe(true);
    expect(secondSense?.offline.assetIds.length).toBeGreaterThan(0);
    expect(secondSense?.offline.estimatedBytes).toBeGreaterThan(0);
    expect(secondSense?.save).toEqual({
      local: true,
      cloud: true,
      slots: "single",
      deterministicSeed: true,
    });
  });

  it("validates without importing any loader into the registry", () => {
    expect(getVectorRegistryIssues(VECTOR_GAME_REGISTRY, getVectorLoaderEngines())).toEqual([]);

    const source = readFileSync("src/lib/vector/registry.ts", "utf8");
    expect(source).not.toMatch(/from ["']@\/lib\/vector\/loaders/);
    expect(source).not.toMatch(/\bimport\s*\(/);
    expect(source).not.toMatch(/from ["']react/);
  });

  it("validates the loader identity that the runtime will actually execute", () => {
    const game: VectorGameManifest = {
      ...VECTOR_GAME_REGISTRY[0],
      loaderKey: "neon-rift",
    };
    expect(getVectorRegistryIssues([game], {})).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "LOADER_KEY_MISMATCH" }),
    ]));
  });

  it("keeps the lobby import graph separate from runtime loaders and game engines", () => {
    const lobbySource = readFileSync("src/components/vector/VectorLobbyModule.tsx", "utf8");
    expect(lobbySource).not.toMatch(/vector\/loaders|GameRuntimeHost|phaser|three/i);
  });

  it("uses the deliberate native, Phaser, and Three engine split", () => {
    expect(getVectorGame("second-sense")?.engine).toBe("native");
    expect(
      VECTOR_GAME_REGISTRY.filter((game) => game.engine === "phaser").map((game) => game.slug),
    ).toEqual(["brickrise", "time-to-fly", "envoy-arena", "phantasy-axis"]);
    expect(
      VECTOR_GAME_REGISTRY.filter((game) => game.engine === "three").map((game) => game.slug),
    ).toEqual(["paper-glider", "biome-lab", "mini-town", "neon-rift"]);
  });

  it("rejects duplicate, impossible, and falsely available manifests", () => {
    // Use a still-planned game as the base so this generic-badness fixture
    // stays decoupled from Second Sense's real (now "available", ready
    // artwork) manifest shape.
    const base = VECTOR_GAME_REGISTRY.find((game) => game.slug === "brickrise")!;
    const badAvailable: VectorGameManifest = {
      ...base,
      status: "available",
      input: { ...base.input, keyboard: false },
      controls: [
        ...base.controls,
        { ...base.controls[0], id: base.controls[1].id },
      ],
      offline: {
        ...base.offline,
        available: true,
      },
    };
    const issues = getVectorRegistryIssues([badAvailable, badAvailable], {
      brickrise: "three",
    });
    const codes = issues.map((issue) => issue.code);

    expect(codes).toEqual(expect.arrayContaining([
      "DUPLICATE_ID",
      "DUPLICATE_SLUG",
      "DUPLICATE_CONTROL",
      "IMPOSSIBLE_CONTROL",
      "INVALID_OFFLINE_MANIFEST",
      "ENGINE_LOADER_MISMATCH",
      "AVAILABLE_WITHOUT_ARTWORK",
      "AVAILABLE_WITH_PLACEHOLDER_VERSION",
    ]));
  });

  it("resolves known games and rejects unknown routes", () => {
    expect(getVectorGame("mini-town")?.title).toBe("MiniTown");
    expect(getVectorGame("not-a-game")).toBeUndefined();
    expect(() => requireVectorGame("not-a-game")).toThrow("Unknown VECTOR game");
  });

  it("fails visibly when a planned game has no runtime loader", async () => {
    await expect(loadVectorGame("brickrise")).rejects.toBeInstanceOf(
      VectorGameLoaderUnavailableError,
    );
  });

  it("loads the real Second Sense game module through its route-isolated loader", async () => {
    const gameModule = await loadVectorGame("second-sense");
    expect(typeof gameModule.createGame).toBe("function");
  });
});
