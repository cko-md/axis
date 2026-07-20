import type {
  VectorGameLoaderDescriptor,
  VectorGameModule,
  VectorGameSlug,
} from "@/lib/vector/types";

/**
 * Game code belongs behind explicit literal dynamic imports in this map.
 *
 * Keep this module out of the lobby, navigation, registry, metadata, and shared
 * shell import graphs. Second Sense (Wave 15.3) is the first complete title;
 * the remaining eight games stay planned until each passes its own
 * complete-game gate. The webpackChunkName below is load-bearing: the VECTOR
 * offline package config (config/vector-offline-packages.json) matches this
 * game's production chunk by a `second-sense-*.js` filename pattern so the
 * exact code an offline install needs can be identified and cached.
 */
export const VECTOR_GAME_LOADERS: Partial<Record<VectorGameSlug, VectorGameLoaderDescriptor>> =
  Object.freeze({
    "second-sense": {
      engine: "native",
      load: () => import(
        /* webpackChunkName: "second-sense" */
        "@/lib/vector/games/second-sense/game"
      ).then((module) => module.default),
    },
    // Brickrise's mechanical core and Phaser shell are complete (Wave 15.8),
    // but the registry keeps it `planned` until the design layer delivers
    // sprites and lighting — a loader on a planned game is valid, and flipping
    // status without artwork trips AVAILABLE_WITHOUT_ARTWORK.
    //
    // The chunk name below covers this module's own first-party code. Phaser
    // itself is named separately by a splitChunks cacheGroup in next.config.ts
    // (`vector-engine-phaser`), NOT by a magic comment — see game.ts.
    brickrise: {
      engine: "phaser",
      load: () => import(
        /* webpackChunkName: "brickrise" */
        "@/lib/vector/games/brickrise/game"
      ).then((module) => module.default),
    },
    // Time to Fly (Wave 15.9) follows the same pattern: pure core plus Phaser
    // shell complete, registry `planned` until artwork lands. As with
    // Brickrise, the chunk name below covers only this module's first-party
    // code; Phaser itself is named by the next.config.ts cacheGroup.
    "time-to-fly": {
      engine: "phaser",
      load: () => import(
        /* webpackChunkName: "time-to-fly" */
        "@/lib/vector/games/time-to-fly/game"
      ).then((module) => module.default),
    },
    // Wave 15.10 engine-isolation skeleton: this loader exists so the plain
    // Three dynamic import inside the game module is reachable and the
    // `vector-engine-three` chunk contract is proven before gameplay lands.
    // Same planned-with-loader shape Brickrise used before its artwork.
    // (The engine import itself lives in game.ts, deliberately uncommented —
    // see engine-chunks.test.ts for why naming it here would defeat it.)
    "paper-glider": {
      engine: "three",
      load: () => import(
        /* webpackChunkName: "paper-glider" */
        "@/lib/vector/games/paper-glider/game"
      ).then((module) => module.default),
    },
  });

export class VectorGameLoaderUnavailableError extends Error {
  readonly code = "VECTOR_GAME_LOADER_UNAVAILABLE";

  constructor(readonly gameId: VectorGameSlug) {
    super(`VECTOR game loader is unavailable for ${gameId}.`);
    this.name = "VectorGameLoaderUnavailableError";
  }
}

export function getVectorGameLoader(gameId: VectorGameSlug): VectorGameLoaderDescriptor | undefined {
  return VECTOR_GAME_LOADERS[gameId];
}

export function getVectorLoaderEngines() {
  return Object.fromEntries(
    Object.entries(VECTOR_GAME_LOADERS).map(([gameId, descriptor]) => [gameId, descriptor?.engine]),
  ) as Partial<Record<VectorGameSlug, VectorGameLoaderDescriptor["engine"]>>;
}

export async function loadVectorGame(gameId: VectorGameSlug): Promise<VectorGameModule> {
  const descriptor = getVectorGameLoader(gameId);
  if (!descriptor) throw new VectorGameLoaderUnavailableError(gameId);
  return descriptor.load();
}
