import type {
  VectorGameLoaderDescriptor,
  VectorGameModule,
  VectorGameSlug,
} from "@/lib/vector/types";

/**
 * Game code belongs behind explicit literal dynamic imports in this map.
 *
 * Keep this module out of the lobby, navigation, registry, metadata, and shared
 * shell import graphs. All nine games remain planned in Wave 15.2, so the map is
 * intentionally empty until Second Sense passes its complete-game gate.
 */
export const VECTOR_GAME_LOADERS: Partial<Record<VectorGameSlug, VectorGameLoaderDescriptor>> =
  Object.freeze({});

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
