import { z } from "zod";
import { getVectorGame } from "@/lib/vector/registry";
import {
  isAllowedVectorManifestUrl,
  isAllowedVectorOfflineEntryUrl,
} from "@/lib/vector/offline";
import type { VectorGameSlug } from "@/lib/vector/types";

export const VECTOR_OFFLINE_BUILD_MAP_URL = "/vector-assets/manifests/build-map.json";
const SHA256 = /^[a-f0-9]{64}$/;
const BUILD_ID = /^[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,159}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i;
const MAX_BUILD_MAP_BYTES = 256 * 1024;

const deploymentSchema = z.object({
  gameId: z.string().min(1).max(100),
  gameVersion: z.string().regex(VERSION),
  buildId: z.string().regex(BUILD_ID),
  manifestUrl: z.string().min(1).max(500),
  manifestSha256: z.string().regex(SHA256),
  offlineEntryUrl: z.string().min(1).max(500),
  estimatedBytes: z.number().int().nonnegative().max(500 * 1024 * 1024),
}).strict();

const buildMapSchema = z.object({
  schemaVersion: z.literal(1),
  buildId: z.string().regex(BUILD_ID),
  games: z.array(deploymentSchema).max(100),
}).strict();

export type VectorOfflineDeployment = z.infer<typeof deploymentSchema> & {
  gameId: VectorGameSlug;
};

export type VectorOfflineBuildMap = {
  schemaVersion: 1;
  buildId: string;
  games: VectorOfflineDeployment[];
};

export function parseVectorOfflineBuildMap(
  input: unknown,
  baseUrl: string,
): { ok: true; map: VectorOfflineBuildMap } | { ok: false; error: string } {
  const parsed = buildMapSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "VECTOR_OFFLINE_BUILD_MAP_INVALID" };

  const seen = new Set<string>();
  const games: VectorOfflineDeployment[] = [];
  for (const deployment of parsed.data.games) {
    const game = getVectorGame(deployment.gameId);
    if (
      seen.has(deployment.gameId) ||
      deployment.buildId !== parsed.data.buildId ||
      !game ||
      game.status !== "available" ||
      !game.offline.available ||
      game.version !== deployment.gameVersion ||
      !isAllowedVectorManifestUrl(deployment.manifestUrl, baseUrl) ||
      !isAllowedVectorOfflineEntryUrl(deployment.offlineEntryUrl, baseUrl)
    ) {
      return { ok: false, error: "VECTOR_OFFLINE_BUILD_MAP_REGISTRY_MISMATCH" };
    }
    seen.add(deployment.gameId);
    games.push({ ...deployment, gameId: game.id });
  }
  return {
    ok: true,
    map: { schemaVersion: 1, buildId: parsed.data.buildId, games },
  };
}

export async function loadVectorOfflineBuildMap(): Promise<VectorOfflineBuildMap> {
  if (typeof window === "undefined") {
    throw new Error("VECTOR_OFFLINE_BUILD_MAP_UNAVAILABLE");
  }
  const response = await fetch(VECTOR_OFFLINE_BUILD_MAP_URL, {
    cache: "no-store",
    credentials: "omit",
    headers: { Accept: "application/json" },
  });
  const expectedUrl = new URL(VECTOR_OFFLINE_BUILD_MAP_URL, window.location.origin).href;
  if (
    !response.ok ||
    response.type === "opaque" ||
    response.headers.has("Set-Cookie") ||
    response.url !== expectedUrl
  ) {
    throw new Error("VECTOR_OFFLINE_BUILD_MAP_UNAVAILABLE");
  }
  const declaredBytes = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declaredBytes) && declaredBytes > MAX_BUILD_MAP_BYTES) {
    throw new Error("VECTOR_OFFLINE_BUILD_MAP_INVALID");
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_BUILD_MAP_BYTES) {
    throw new Error("VECTOR_OFFLINE_BUILD_MAP_INVALID");
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("VECTOR_OFFLINE_BUILD_MAP_INVALID");
  }
  const parsed = parseVectorOfflineBuildMap(value, window.location.origin);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.map;
}

export function indexVectorOfflineDeployments(
  map: VectorOfflineBuildMap,
): Partial<Record<VectorGameSlug, VectorOfflineDeployment>> {
  return Object.fromEntries(map.games.map((deployment) => [deployment.gameId, deployment]));
}
