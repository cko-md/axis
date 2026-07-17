import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { captureRouteError } from "@/lib/observability/captureRouteError";
import { memoryRateLimit, redisRateLimit } from "@/lib/ratelimit";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json, Tables } from "@/lib/supabase/database.types";
import { createClient } from "@/lib/supabase/server";
import {
  vectorConflictResolutionSchema,
  vectorSyncItemResultSchema,
} from "@/lib/vector/contracts";
import { hashVectorPayload } from "@/lib/vector/checksum";
import {
  parseVectorJsonBody,
  vectorCloudConflictFromRow,
  vectorCloudSaveFromRow,
} from "@/lib/vector/server";

const ROUTE = "vector.conflict";
const READ_RATE_LIMIT = 120;
const MUTATION_RATE_LIMIT = 30;
const UUID_SCHEMA = z.string().uuid();
const CONFLICT_BODY_MAX_BYTES = 16 * 1024;
const CONFLICT_COLUMNS = "id, user_id, game_id, slot_id, reason, conflict_version, status, resolution, local_revision, local_game_version, local_save_schema_version, local_checksum, local_seed, local_state, local_updated_at, server_revision, server_game_version, server_save_schema_version, server_checksum, server_seed, server_state, server_updated_at, created_at, resolved_at";
type RouteContext = { params: Promise<{ id: string }> };

async function authenticate() {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  return { supabase, user: error ? null : user };
}

async function checkRateLimit(
  userId: string,
  limit: number,
  operation: "read" | "mutation",
) {
  const key = `vector-conflict-${operation}`;
  try {
    return (
      (await redisRateLimit(userId, limit, "1 m", `axis:${key}`)) ??
      memoryRateLimit(`${key}:${userId}`, limit, 60_000)
    );
  } catch (error) {
    captureRouteError(error, {
      route: ROUTE,
      operation: "rate_limit",
      area: "vector",
      status: 500,
      code: "VECTOR_RATE_LIMIT_UNAVAILABLE",
    });
    return memoryRateLimit(`${key}:${userId}`, limit, 60_000);
  }
}

export async function GET(_request: NextRequest, context: RouteContext) {
  const { supabase, user } = await authenticate();
  if (!user) return NextResponse.json({ error: "VECTOR_UNAUTHORIZED" }, { status: 401 });
  const { success } = await checkRateLimit(user.id, READ_RATE_LIMIT, "read");
  if (!success) {
    return NextResponse.json(
      { error: "VECTOR_RATE_LIMITED" },
      {
        status: 429,
        headers: { "cache-control": "private, no-store", "retry-after": "60" },
      },
    );
  }
  const parsedId = UUID_SCHEMA.safeParse((await context.params).id);
  if (!parsedId.success) {
    return NextResponse.json({ error: "VECTOR_CONFLICT_NOT_FOUND" }, { status: 404 });
  }
  const { data, error } = await supabase
    .from("game_save_conflicts")
    .select(CONFLICT_COLUMNS)
    .eq("user_id", user.id)
    .eq("id", parsedId.data)
    .maybeSingle();
  if (error) {
    captureRouteError(error, {
      route: ROUTE,
      operation: "get",
      area: "vector",
      status: 500,
      code: "VECTOR_CONFLICT_UNAVAILABLE",
    });
    return NextResponse.json({ error: "VECTOR_CONFLICT_UNAVAILABLE" }, { status: 500 });
  }
  if (!data) return NextResponse.json({ error: "VECTOR_CONFLICT_NOT_FOUND" }, { status: 404 });
  return NextResponse.json({
    conflict: vectorCloudConflictFromRow(data as Tables<"game_save_conflicts">, true),
  }, {
    headers: { "cache-control": "private, no-store" },
  });
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const { supabase, user } = await authenticate();
  if (!user) return NextResponse.json({ error: "VECTOR_UNAUTHORIZED" }, { status: 401 });
  const { success } = await checkRateLimit(
    user.id,
    MUTATION_RATE_LIMIT,
    "mutation",
  );
  if (!success) {
    return NextResponse.json(
      { error: "VECTOR_RATE_LIMITED" },
      {
        status: 429,
        headers: { "cache-control": "private, no-store", "retry-after": "60" },
      },
    );
  }
  const parsedId = UUID_SCHEMA.safeParse((await context.params).id);
  if (!parsedId.success) {
    return NextResponse.json({ error: "VECTOR_CONFLICT_NOT_FOUND" }, { status: 404 });
  }
  const parsedBody = await parseVectorJsonBody(
    request,
    vectorConflictResolutionSchema,
    CONFLICT_BODY_MAX_BYTES,
  );
  if (!parsedBody.ok) {
    return NextResponse.json({ error: parsedBody.code }, { status: parsedBody.status });
  }

  const { data: ownedConflict, error: ownerError } = await supabase
    .from("game_save_conflicts")
    .select("id, game_id, slot_id")
    .eq("user_id", user.id)
    .eq("id", parsedId.data)
    .maybeSingle();
  if (ownerError) {
    captureRouteError(ownerError, {
      route: ROUTE,
      operation: "verify_owner",
      area: "vector",
      status: 500,
      code: "VECTOR_CONFLICT_UNAVAILABLE",
    });
    return NextResponse.json({ error: "VECTOR_CONFLICT_UNAVAILABLE" }, { status: 500 });
  }
  if (!ownedConflict) {
    return NextResponse.json({ error: "VECTOR_CONFLICT_NOT_FOUND" }, { status: 404 });
  }
  const admin = createAdminClient();
  if (!admin) {
    return NextResponse.json({
      error: "VECTOR_SYNC_UNAVAILABLE",
      message: "Cloud synchronization is not configured.",
    }, { status: 503 });
  }
  const body = parsedBody.data;
  const payloadHash = await hashVectorPayload({
    conflictId: parsedId.data,
    ...body,
  } as unknown as Json);
  const { data: rpcData, error: rpcError } = await admin.rpc("resolve_vector_conflict", {
    p_user_id: user.id,
    p_conflict_id: parsedId.data,
    p_idempotency_key: body.idempotencyKey,
    p_payload_hash: payloadHash,
    p_expected_conflict_version: body.expectedConflictVersion,
    p_resolution: body.resolution,
    p_target_slot_id: body.targetSlotId ?? null,
  });
  const parsedResult = vectorSyncItemResultSchema.safeParse(rpcData);
  if (rpcError || !parsedResult.success) {
    captureRouteError(rpcError ?? new Error("Invalid resolve_vector_conflict result"), {
      route: ROUTE,
      operation: "resolve",
      area: "vector",
      status: 500,
      code: "VECTOR_CONFLICT_RESOLVE_FAILED",
      tags: { game_id: ownedConflict.game_id, resolution: body.resolution },
    });
    return NextResponse.json({ error: "VECTOR_CONFLICT_RESOLVE_FAILED" }, { status: 500 });
  }
  if (parsedResult.data.status === "rejected") {
    const notFound = parsedResult.data.code === "VECTOR_CONFLICT_NOT_FOUND";
    return NextResponse.json({
      error: parsedResult.data.code ?? "VECTOR_CONFLICT_REJECTED",
      result: parsedResult.data,
    }, { status: notFound ? 404 : 409 });
  }

  const [conflictResult, savesResult] = await Promise.all([
    supabase
      .from("game_save_conflicts")
      .select(CONFLICT_COLUMNS)
      .eq("user_id", user.id)
      .eq("id", parsedId.data)
      .single(),
    supabase
      .from("game_saves")
      .select("user_id, game_id, slot_id, game_version, save_schema_version, server_revision, client_revision, device_id, checksum, seed, state, updated_at, deleted_at")
      .eq("user_id", user.id)
      .eq("game_id", ownedConflict.game_id)
      .in("slot_id", [ownedConflict.slot_id, body.targetSlotId].filter(Boolean) as string[])
      .is("deleted_at", null),
  ]);
  if (conflictResult.error || savesResult.error) {
    captureRouteError(conflictResult.error ?? savesResult.error, {
      route: ROUTE,
      operation: "refresh",
      area: "vector",
      status: 503,
      code: "VECTOR_CONFLICT_REFRESH_FAILED",
      tags: { game_id: ownedConflict.game_id },
    });
    return NextResponse.json({ error: "VECTOR_CONFLICT_REFRESH_FAILED" }, { status: 503 });
  }
  return NextResponse.json({
    result: parsedResult.data,
    conflict: vectorCloudConflictFromRow(
      conflictResult.data as Tables<"game_save_conflicts">,
      true,
    ),
    saves: (savesResult.data ?? []).map((row) =>
      vectorCloudSaveFromRow(row as Tables<"game_saves">, true)),
  }, {
    headers: { "cache-control": "private, no-store" },
  });
}
