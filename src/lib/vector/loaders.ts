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
