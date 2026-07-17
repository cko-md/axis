import { NextRequest, NextResponse } from "next/server";
import { captureRouteError } from "@/lib/observability/captureRouteError";
import { memoryRateLimit, redisRateLimit } from "@/lib/ratelimit";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json, Tables } from "@/lib/supabase/database.types";
import { createClient } from "@/lib/supabase/server";
import {
  VECTOR_EVENT_MAX_PAYLOAD_BYTES,
  VECTOR_SAVE_MAX_STATE_BYTES,
  VECTOR_SYNC_REFRESH_MAX_CONFLICTS,
  VECTOR_SYNC_REFRESH_MAX_SAVES,
  vectorSyncItemResultSchema,
  vectorSyncRequestSchema,
  vectorSyncResponseSchema,
  type VectorSyncItemResult,
} from "@/lib/vector/contracts";
import {
  checksumVectorState,
  hashVectorPayload,
  vectorJsonBytes,
} from "@/lib/vector/checksum";
import {
  parseVectorJsonBody,
  vectorCloudConflictFromRow,
  vectorCloudSaveFromRow,
} from "@/lib/vector/server";

const ROUTE = "vector.sync";
const RATE_LIMIT = 120;
const SETTING_CLOCK_MAX_FUTURE_MS = 5 * 60 * 1000;
const SAVE_COLUMNS = "user_id, game_id, slot_id, game_version, save_schema_version, server_revision, client_revision, device_id, checksum, seed, state, updated_at, deleted_at";
const CONFLICT_COLUMNS = "id, user_id, game_id, slot_id, reason, conflict_version, status, resolution, local_revision, local_game_version, local_save_schema_version, local_checksum, local_seed, local_state, local_updated_at, server_revision, server_game_version, server_save_schema_version, server_checksum, server_seed, server_state, server_updated_at, created_at, resolved_at";

async function checkRateLimit(userId: string) {
  try {
    return (
      (await redisRateLimit(userId, RATE_LIMIT, "1 m", "axis:vector-sync")) ??
      memoryRateLimit(`vector-sync:${userId}`, RATE_LIMIT, 60_000)
    );
  } catch (error) {
    captureRouteError(error, {
      route: ROUTE,
      operation: "rate_limit",
      area: "vector",
      status: 500,
      code: "VECTOR_RATE_LIMIT_UNAVAILABLE",
    });
    return memoryRateLimit(`vector-sync:${userId}`, RATE_LIMIT, 60_000);
  }
}

function rejectedResult(input: {
  idempotencyKey: string;
  kind: VectorSyncItemResult["kind"];
  code: string;
  slotId?: string;
  localRevision?: number;
}): VectorSyncItemResult {
  return {
    idempotencyKey: input.idempotencyKey,
    kind: input.kind,
    status: "rejected",
    code: input.code,
    slotId: input.slotId ?? null,
    localRevision: input.localRevision ?? null,
    serverRevision: null,
    conflictId: null,
  };
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "VECTOR_UNAUTHORIZED" }, { status: 401 });
  }
  const { success } = await checkRateLimit(user.id);
  if (!success) {
    return NextResponse.json(
      { error: "VECTOR_RATE_LIMITED" },
      {
        status: 429,
        headers: { "cache-control": "private, no-store", "retry-after": "60" },
      },
    );
  }
  const parsedBody = await parseVectorJsonBody(request, vectorSyncRequestSchema);
  if (!parsedBody.ok) {
    return NextResponse.json({ error: parsedBody.code }, { status: parsedBody.status });
  }
  const admin = createAdminClient();
  if (!admin) {
    return NextResponse.json({
      error: "VECTOR_SYNC_UNAVAILABLE",
      message: "Cloud synchronization is not configured.",
    }, { status: 503 });
  }

  const body = parsedBody.data;
  const results: VectorSyncItemResult[] = [];
  for (const [index, save] of body.saves.entries()) {
    if (vectorJsonBytes(save.state) > VECTOR_SAVE_MAX_STATE_BYTES) {
      results.push(rejectedResult({
        idempotencyKey: save.idempotencyKey,
        kind: "save",
        code: "VECTOR_SAVE_TOO_LARGE",
        slotId: save.slotId,
        localRevision: save.localRevision,
      }));
      continue;
    }
    if (await checksumVectorState(save.state) !== save.checksum) {
      results.push(rejectedResult({
        idempotencyKey: save.idempotencyKey,
        kind: "save",
        code: "VECTOR_CHECKSUM_MISMATCH",
        slotId: save.slotId,
        localRevision: save.localRevision,
      }));
      continue;
    }
    const payloadHash = await hashVectorPayload(save as unknown as Json);
    const { data, error } = await admin.rpc("sync_vector_save", {
      p_user_id: user.id,
      p_game_id: body.gameId,
      p_device_id: body.deviceId,
      p_idempotency_key: save.idempotencyKey,
      p_payload_hash: payloadHash,
      p_slot_id: save.slotId,
      p_game_version: save.gameVersion,
      p_save_schema_version: save.saveSchemaVersion,
      p_expected_server_revision: save.expectedServerRevision,
      p_client_revision: save.localRevision,
      p_checksum: save.checksum,
      p_seed: save.seed,
      p_state: save.state,
      p_updated_at: save.updatedAt,
    });
    const parsedResult = vectorSyncItemResultSchema.safeParse(data);
    if (error || !parsedResult.success) {
      captureRouteError(error ?? new Error("Invalid sync_vector_save result"), {
        route: ROUTE,
        operation: "save",
        area: "vector",
        status: 500,
        code: "VECTOR_SAVE_SYNC_FAILED",
        tags: { game_id: body.gameId, item_index: index },
      });
      results.push(rejectedResult({
        idempotencyKey: save.idempotencyKey,
        kind: "save",
        code: "VECTOR_SAVE_SYNC_FAILED",
        slotId: save.slotId,
        localRevision: save.localRevision,
      }));
      continue;
    }
    results.push(parsedResult.data);
  }

  for (const [index, event] of body.events.entries()) {
    if (vectorJsonBytes(event as unknown as Json) > VECTOR_EVENT_MAX_PAYLOAD_BYTES) {
      results.push(rejectedResult({
        idempotencyKey: event.idempotencyKey,
        kind: event.kind,
        code: "VECTOR_EVENT_TOO_LARGE",
        localRevision: event.localRevision,
      }));
      continue;
    }
    if (
      event.kind === "settings" &&
      Object.values(event.payload.clocks).some((clock) => (
        Date.parse(clock.at) > Date.now() + SETTING_CLOCK_MAX_FUTURE_MS
      ))
    ) {
      results.push(rejectedResult({
        idempotencyKey: event.idempotencyKey,
        kind: event.kind,
        code: "VECTOR_SETTING_CLOCK_FUTURE",
        localRevision: event.localRevision,
      }));
      continue;
    }
    const payloadHash = await hashVectorPayload(event as unknown as Json);
    const { data, error } = await admin.rpc("apply_vector_event", {
      p_user_id: user.id,
      p_game_id: body.gameId,
      p_device_id: body.deviceId,
      p_idempotency_key: event.idempotencyKey,
      p_payload_hash: payloadHash,
      p_client_revision: event.localRevision,
      p_event_kind: event.kind,
      p_payload: event.payload,
      p_occurred_at: event.occurredAt,
    });
    const parsedResult = vectorSyncItemResultSchema.safeParse(data);
    if (error || !parsedResult.success) {
      captureRouteError(error ?? new Error("Invalid apply_vector_event result"), {
        route: ROUTE,
        operation: "event",
        area: "vector",
        status: 500,
        code: "VECTOR_EVENT_SYNC_FAILED",
        tags: { game_id: body.gameId, event_kind: event.kind, item_index: index },
      });
      results.push(rejectedResult({
        idempotencyKey: event.idempotencyKey,
        kind: event.kind,
        code: "VECTOR_EVENT_SYNC_FAILED",
        localRevision: event.localRevision,
      }));
      continue;
    }
    results.push(parsedResult.data);
  }

  const [savesResult, conflictsResult] = await Promise.all([
    supabase
      .from("game_saves")
      .select(SAVE_COLUMNS)
      .eq("user_id", user.id)
      .eq("game_id", body.gameId)
      .is("deleted_at", null)
      .order("updated_at", { ascending: false })
      .limit(VECTOR_SYNC_REFRESH_MAX_SAVES + 1),
    supabase
      .from("game_save_conflicts")
      .select(CONFLICT_COLUMNS)
      .eq("user_id", user.id)
      .eq("game_id", body.gameId)
      .eq("status", "open")
      .order("created_at", { ascending: false })
      .limit(VECTOR_SYNC_REFRESH_MAX_CONFLICTS + 1),
  ]);
  if (savesResult.error || conflictsResult.error) {
    captureRouteError(savesResult.error ?? conflictsResult.error, {
      route: ROUTE,
      operation: "refresh",
      area: "vector",
      status: 503,
      code: "VECTOR_SYNC_REFRESH_FAILED",
      tags: { game_id: body.gameId },
    });
    return NextResponse.json({ error: "VECTOR_SYNC_REFRESH_FAILED" }, { status: 503 });
  }

  const saveRows = savesResult.data ?? [];
  const conflictRows = conflictsResult.data ?? [];
  const truncated = {
    saves: saveRows.length > VECTOR_SYNC_REFRESH_MAX_SAVES,
    conflicts: conflictRows.length > VECTOR_SYNC_REFRESH_MAX_CONFLICTS,
  };
  const response = vectorSyncResponseSchema.safeParse({
    partial: results.some((result) => (
      result.status === "rejected" || result.status === "conflict"
    )) || truncated.saves || truncated.conflicts,
    results,
    saves: saveRows.slice(0, VECTOR_SYNC_REFRESH_MAX_SAVES).map((row) =>
      vectorCloudSaveFromRow(row as Tables<"game_saves">, true)),
    conflicts: conflictRows.slice(0, VECTOR_SYNC_REFRESH_MAX_CONFLICTS).map((row) =>
      vectorCloudConflictFromRow(row as Tables<"game_save_conflicts">, true)),
    truncated,
    serverTime: new Date().toISOString(),
  });
  if (!response.success) {
    captureRouteError(new Error("VECTOR sync response validation failed"), {
      route: ROUTE,
      operation: "serialize",
      area: "vector",
      status: 500,
      code: "VECTOR_SYNC_RESPONSE_INVALID",
      tags: { game_id: body.gameId },
    });
    return NextResponse.json({ error: "VECTOR_SYNC_RESPONSE_INVALID" }, { status: 500 });
  }
  return NextResponse.json(response.data, {
    headers: { "cache-control": "private, no-store" },
  });
}
