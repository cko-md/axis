import { NextRequest, NextResponse } from "next/server";
import { captureRouteError } from "@/lib/observability/captureRouteError";
import { memoryRateLimit, redisRateLimit } from "@/lib/ratelimit";
import type { Tables } from "@/lib/supabase/database.types";
import { createClient } from "@/lib/supabase/server";
import {
  VECTOR_BOOTSTRAP_MAX_ACHIEVEMENTS,
  VECTOR_BOOTSTRAP_MAX_CONFLICTS,
  VECTOR_BOOTSTRAP_MAX_RESPONSE_BYTES,
  VECTOR_BOOTSTRAP_MAX_SAVES,
  VECTOR_BOOTSTRAP_MAX_SCORES,
  vectorBootstrapQuerySchema,
  vectorBootstrapResponseSchema,
} from "@/lib/vector/contracts";
import {
  vectorCloudConflictFromRow,
  vectorCloudSaveFromRow,
} from "@/lib/vector/server";

const ROUTE = "vector.bootstrap";
const RATE_LIMIT = 60;
const SAVE_COLUMNS = "user_id, game_id, slot_id, game_version, save_schema_version, server_revision, client_revision, device_id, checksum, seed, updated_at, deleted_at";
const CONFLICT_COLUMNS = "id, user_id, game_id, slot_id, reason, conflict_version, status, resolution, local_revision, local_game_version, local_save_schema_version, local_checksum, local_seed, local_updated_at, server_revision, server_game_version, server_save_schema_version, server_checksum, server_seed, server_updated_at, created_at, resolved_at";

async function checkRateLimit(userId: string) {
  try {
    return (
      (await redisRateLimit(userId, RATE_LIMIT, "1 m", "axis:vector-bootstrap")) ??
      memoryRateLimit(`vector-bootstrap:${userId}`, RATE_LIMIT, 60_000)
    );
  } catch (error) {
    captureRouteError(error, {
      route: ROUTE,
      operation: "rate_limit",
      area: "vector",
      status: 500,
      code: "VECTOR_RATE_LIMIT_UNAVAILABLE",
    });
    return memoryRateLimit(`vector-bootstrap:${userId}`, RATE_LIMIT, 60_000);
  }
}

export async function GET(request: NextRequest) {
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

  const parsedQuery = vectorBootstrapQuerySchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams.entries()),
  );
  if (!parsedQuery.success) {
    return NextResponse.json({ error: "VECTOR_INVALID_QUERY" }, { status: 400 });
  }
  const includeState = parsedQuery.data.includeState === "1";
  const gameId = parsedQuery.data.gameId;

  let savesQuery = supabase
    .from("game_saves")
    .select(includeState ? `${SAVE_COLUMNS}, state` : SAVE_COLUMNS)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .order("updated_at", { ascending: false })
    .limit(VECTOR_BOOTSTRAP_MAX_SAVES + 1);
  let scoresQuery = supabase
    .from("game_scores")
    .select("game_id, mode, challenge_id, score, verification_status, updated_at")
    .eq("user_id", user.id)
    .order("updated_at", { ascending: false })
    .limit(VECTOR_BOOTSTRAP_MAX_SCORES + 1);
  let achievementsQuery = supabase
    .from("game_achievements")
    .select("game_id, achievement_id, unlocked_at")
    .eq("user_id", user.id)
    .order("unlocked_at", { ascending: false })
    .limit(VECTOR_BOOTSTRAP_MAX_ACHIEVEMENTS + 1);
  let conflictsQuery = supabase
    .from("game_save_conflicts")
    .select(includeState
      ? `${CONFLICT_COLUMNS}, local_state, server_state`
      : CONFLICT_COLUMNS)
    .eq("user_id", user.id)
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .limit(VECTOR_BOOTSTRAP_MAX_CONFLICTS + 1);
  if (gameId) {
    savesQuery = savesQuery.eq("game_id", gameId);
    scoresQuery = scoresQuery.eq("game_id", gameId);
    achievementsQuery = achievementsQuery.eq("game_id", gameId);
    conflictsQuery = conflictsQuery.eq("game_id", gameId);
  }

  const [profileResult, savesResult, scoresResult, achievementsResult, conflictsResult] =
    await Promise.all([
      supabase
        .from("game_profiles")
        .select("settings, setting_clocks, unlocks, counters, server_revision, updated_at")
        .eq("user_id", user.id)
        .maybeSingle(),
      savesQuery,
      scoresQuery,
      achievementsQuery,
      conflictsQuery,
    ]);
  const failure = [
    profileResult.error,
    savesResult.error,
    scoresResult.error,
    achievementsResult.error,
    conflictsResult.error,
  ].find(Boolean);
  if (failure) {
    captureRouteError(failure, {
      route: ROUTE,
      operation: "load",
      area: "vector",
      status: 500,
      code: "VECTOR_BOOTSTRAP_UNAVAILABLE",
      tags: { game_id: gameId },
    });
    return NextResponse.json({ error: "VECTOR_BOOTSTRAP_UNAVAILABLE" }, { status: 500 });
  }

  const profile = profileResult.data;
  const saveRows = savesResult.data ?? [];
  const scoreRows = scoresResult.data ?? [];
  const achievementRows = achievementsResult.data ?? [];
  const conflictRows = conflictsResult.data ?? [];
  const response = vectorBootstrapResponseSchema.safeParse({
    profile: profile ? {
      settings: profile.settings,
      settingClocks: profile.setting_clocks,
      unlocks: profile.unlocks,
      counters: profile.counters,
      serverRevision: profile.server_revision,
      updatedAt: profile.updated_at,
    } : null,
    saves: saveRows.slice(0, VECTOR_BOOTSTRAP_MAX_SAVES).map((row) =>
      vectorCloudSaveFromRow(row as unknown as Tables<"game_saves">, includeState)),
    scores: scoreRows.slice(0, VECTOR_BOOTSTRAP_MAX_SCORES).map((row) => ({
      gameId: row.game_id,
      mode: row.mode,
      challengeId: row.challenge_id,
      score: row.score,
      verificationStatus: row.verification_status,
      updatedAt: row.updated_at,
    })),
    achievements: achievementRows.slice(0, VECTOR_BOOTSTRAP_MAX_ACHIEVEMENTS).map((row) => ({
      gameId: row.game_id,
      achievementId: row.achievement_id,
      unlockedAt: row.unlocked_at,
    })),
    conflicts: conflictRows.slice(0, VECTOR_BOOTSTRAP_MAX_CONFLICTS).map((row) =>
      vectorCloudConflictFromRow(
        row as unknown as Tables<"game_save_conflicts">,
        includeState,
      )),
    truncated: {
      saves: saveRows.length > VECTOR_BOOTSTRAP_MAX_SAVES,
      scores: scoreRows.length > VECTOR_BOOTSTRAP_MAX_SCORES,
      achievements: achievementRows.length > VECTOR_BOOTSTRAP_MAX_ACHIEVEMENTS,
      conflicts: conflictRows.length > VECTOR_BOOTSTRAP_MAX_CONFLICTS,
    },
    serverTime: new Date().toISOString(),
  });
  if (!response.success) {
    captureRouteError(new Error("VECTOR bootstrap response validation failed"), {
      route: ROUTE,
      operation: "serialize",
      area: "vector",
      status: 500,
      code: "VECTOR_BOOTSTRAP_RESPONSE_INVALID",
      tags: { game_id: gameId },
    });
    return NextResponse.json({ error: "VECTOR_BOOTSTRAP_RESPONSE_INVALID" }, { status: 500 });
  }
  const serialized = JSON.stringify(response.data);
  const responseBytes = new TextEncoder().encode(serialized).byteLength;
  if (responseBytes > VECTOR_BOOTSTRAP_MAX_RESPONSE_BYTES) {
    captureRouteError(new Error("VECTOR bootstrap response exceeded its byte limit"), {
      route: ROUTE,
      operation: "serialize",
      area: "vector",
      status: 500,
      code: "VECTOR_BOOTSTRAP_RESPONSE_TOO_LARGE",
      tags: { game_id: gameId },
    });
    return NextResponse.json(
      { error: "VECTOR_BOOTSTRAP_RESPONSE_TOO_LARGE" },
      { status: 500 },
    );
  }
  return new NextResponse(serialized, {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "private, no-store",
    },
  });
}
