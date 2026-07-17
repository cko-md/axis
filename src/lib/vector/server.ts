import type { ZodType } from "zod";
import type { Json, Tables } from "@/lib/supabase/database.types";
import {
  VECTOR_SYNC_MAX_BODY_BYTES,
  type VectorCloudConflict,
  type VectorCloudSave,
} from "@/lib/vector/contracts";

export type VectorBodyParseResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      status: 400 | 413 | 415;
      code: "VECTOR_INVALID_BODY" | "VECTOR_SYNC_TOO_LARGE" | "VECTOR_JSON_REQUIRED";
    };

export async function parseVectorJsonBody<T>(
  request: Request,
  schema: ZodType<T>,
  maxBytes = VECTOR_SYNC_MAX_BODY_BYTES,
): Promise<VectorBodyParseResult<T>> {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    return { ok: false, status: 415, code: "VECTOR_JSON_REQUIRED" };
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength) {
    const parsedLength = Number(declaredLength);
    if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
      return { ok: false, status: 413, code: "VECTOR_SYNC_TOO_LARGE" };
    }
  }
  const reader = request.body?.getReader();
  if (!reader) {
    return { ok: false, status: 400, code: "VECTOR_INVALID_BODY" };
  }
  const decoder = new TextDecoder();
  let text = "";
  let receivedBytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > maxBytes) {
        await reader.cancel("VECTOR_SYNC_TOO_LARGE");
        return { ok: false, status: 413, code: "VECTOR_SYNC_TOO_LARGE" };
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch {
    return { ok: false, status: 400, code: "VECTOR_INVALID_BODY" };
  } finally {
    reader.releaseLock();
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, status: 400, code: "VECTOR_INVALID_BODY" };
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, status: 400, code: "VECTOR_INVALID_BODY" };
  }
  return { ok: true, data: parsed.data };
}

export function vectorCloudSaveFromRow(
  row: Tables<"game_saves">,
  includeState: boolean,
): VectorCloudSave {
  return {
    gameId: row.game_id as VectorCloudSave["gameId"],
    slotId: row.slot_id,
    gameVersion: row.game_version,
    saveSchemaVersion: row.save_schema_version,
    serverRevision: row.server_revision,
    clientRevision: row.client_revision,
    deviceId: row.device_id,
    checksum: row.checksum,
    seed: row.seed,
    ...(includeState ? { state: row.state } : {}),
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

export function vectorCloudConflictFromRow(
  row: Tables<"game_save_conflicts">,
  includeState: boolean,
): VectorCloudConflict {
  return {
    id: row.id,
    gameId: row.game_id as VectorCloudConflict["gameId"],
    slotId: row.slot_id,
    reason: row.reason,
    conflictVersion: row.conflict_version,
    status: row.status as VectorCloudConflict["status"],
    resolution: row.resolution as VectorCloudConflict["resolution"],
    local: {
      localRevision: row.local_revision,
      gameVersion: row.local_game_version,
      saveSchemaVersion: row.local_save_schema_version,
      checksum: row.local_checksum,
      seed: row.local_seed,
      ...(includeState ? { state: row.local_state } : {}),
      updatedAt: row.local_updated_at,
    },
    server: {
      serverRevision: row.server_revision,
      gameVersion: row.server_game_version,
      saveSchemaVersion: row.server_save_schema_version,
      checksum: row.server_checksum,
      seed: row.server_seed,
      ...(includeState && row.server_state !== null ? { state: row.server_state } : {}),
      updatedAt: row.server_updated_at,
    },
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

export function asVectorJson(value: unknown): Json {
  return value as Json;
}
