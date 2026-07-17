import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET as bootstrapGET } from "@/app/api/vector/bootstrap/route";
import { POST as syncPOST } from "@/app/api/vector/sync/route";
import { PATCH as conflictPATCH } from "@/app/api/vector/conflicts/[id]/route";
import {
  VECTOR_BOOTSTRAP_MAX_RESPONSE_BYTES,
  VECTOR_SYNC_MAX_BODY_BYTES,
} from "@/lib/vector/contracts";
import { checksumVectorState } from "@/lib/vector/checksum";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
  captureRouteError: vi.fn(),
  memoryRateLimit: vi.fn(),
  redisRateLimit: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("@/lib/observability/captureRouteError", () => ({
  captureRouteError: mocks.captureRouteError,
}));
vi.mock("@/lib/ratelimit", () => ({
  memoryRateLimit: mocks.memoryRateLimit,
  redisRateLimit: mocks.redisRateLimit,
}));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const CONFLICT_ID = "33333333-3333-4333-8333-333333333333";
const NOW = "2026-07-16T18:00:00.000Z";

function saveRow(index: number) {
  return {
    user_id: USER_ID,
    game_id: "second-sense",
    slot_id: `slot-${index}`,
    game_version: "1.0.0",
    save_schema_version: 1,
    server_revision: 1,
    client_revision: 1,
    device_id: "device-12345678",
    checksum: "a".repeat(64),
    seed: null,
    state: { round: index },
    updated_at: NOW,
    deleted_at: null,
  };
}

function conflictRow(index: number) {
  return {
    id: CONFLICT_ID,
    user_id: USER_ID,
    game_id: "second-sense",
    slot_id: `slot-${index}`,
    reason: "revision_mismatch",
    conflict_version: 1,
    status: "open",
    resolution: null,
    local_revision: 2,
    local_game_version: "1.0.0",
    local_save_schema_version: 1,
    local_checksum: "b".repeat(64),
    local_seed: null,
    local_state: { round: 2 },
    local_updated_at: NOW,
    server_revision: 1,
    server_game_version: "1.0.0",
    server_save_schema_version: 1,
    server_checksum: "a".repeat(64),
    server_seed: null,
    server_state: { round: 1 },
    server_updated_at: NOW,
    created_at: NOW,
    resolved_at: null,
  };
}

function session(userId: string | null, from = vi.fn()) {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: userId ? { id: userId } : null },
        error: null,
      }),
    },
    from,
  };
}

function jsonRequest(url: string, body: unknown, headers?: HeadersInit) {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function limitedRows(data: unknown[] = []) {
  const builder = {
    select: vi.fn(),
    eq: vi.fn(),
    is: vi.fn(),
    order: vi.fn(),
    limit: vi.fn().mockResolvedValue({ data, error: null }),
  };
  builder.select.mockReturnValue(builder);
  builder.eq.mockReturnValue(builder);
  builder.is.mockReturnValue(builder);
  builder.order.mockReturnValue(builder);
  return builder;
}

function scopedRows(data: unknown[] = []) {
  const result = { data, error: null };
  const builder = {
    select: vi.fn(),
    eq: vi.fn(),
    is: vi.fn(),
    order: vi.fn(),
    limit: vi.fn(),
    then: (
      onFulfilled?: (value: typeof result) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => Promise.resolve(result).then(onFulfilled, onRejected),
  };
  builder.select.mockReturnValue(builder);
  builder.eq.mockReturnValue(builder);
  builder.is.mockReturnValue(builder);
  builder.order.mockReturnValue(builder);
  builder.limit.mockReturnValue(builder);
  return builder;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createAdminClient.mockReturnValue(null);
  mocks.redisRateLimit.mockResolvedValue({ success: true });
  mocks.memoryRateLimit.mockReturnValue({ success: true });
});

describe("VECTOR route security boundaries", () => {
  it("requires authentication before bootstrap reads", async () => {
    mocks.createClient.mockResolvedValue(session(null));
    const response = await bootstrapGET(new NextRequest("http://axis.test/api/vector/bootstrap"));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "VECTOR_UNAUTHORIZED" });
  });

  it("rejects unknown bootstrap query parameters", async () => {
    const from = vi.fn();
    mocks.createClient.mockResolvedValue(session(USER_ID, from));
    const response = await bootstrapGET(
      new NextRequest("http://axis.test/api/vector/bootstrap?ownerId=someone-else"),
    );
    expect(response.status).toBe(400);
    expect(from).not.toHaveBeenCalled();
  });

  it("falls back to owner-keyed memory throttling and returns a safe 429", async () => {
    const from = vi.fn();
    mocks.createClient.mockResolvedValue(session(USER_ID, from));
    mocks.redisRateLimit.mockRejectedValue(new Error("redis unavailable"));
    mocks.memoryRateLimit.mockReturnValue({ success: false });

    const response = await bootstrapGET(
      new NextRequest("http://axis.test/api/vector/bootstrap"),
    );

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({ error: "VECTOR_RATE_LIMITED" });
    expect(response.headers.get("retry-after")).toBe("60");
    expect(mocks.memoryRateLimit).toHaveBeenCalledWith(
      `vector-bootstrap:${USER_ID}`,
      60,
      60_000,
    );
    expect(mocks.captureRouteError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ code: "VECTOR_RATE_LIMIT_UNAVAILABLE" }),
    );
    expect(from).not.toHaveBeenCalled();
  });

  it("reports bootstrap truncation instead of silently presenting a complete snapshot", async () => {
    const profile = {
      select: vi.fn(),
      eq: vi.fn(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    };
    profile.select.mockReturnValue(profile);
    profile.eq.mockReturnValue(profile);
    const saves = limitedRows(Array.from({ length: 73 }, (_, index) => saveRow(index)));
    const scores = limitedRows(Array.from({ length: 201 }, (_, index) => ({
      game_id: "second-sense",
      mode: "standard",
      challenge_id: null,
      score: index,
      verification_status: "verified",
      updated_at: NOW,
    })));
    const achievements = limitedRows(Array.from({ length: 501 }, (_, index) => ({
      game_id: "second-sense",
      achievement_id: `achievement-${index}`,
      unlocked_at: NOW,
    })));
    const conflicts = limitedRows(
      Array.from({ length: 101 }, (_, index) => conflictRow(index)),
    );
    const from = vi.fn((table: string) => ({
      game_profiles: profile,
      game_saves: saves,
      game_scores: scores,
      game_achievements: achievements,
      game_save_conflicts: conflicts,
    })[table]);
    mocks.createClient.mockResolvedValue(session(USER_ID, from));

    const response = await bootstrapGET(
      new NextRequest("http://axis.test/api/vector/bootstrap"),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.truncated).toEqual({
      saves: true,
      scores: true,
      achievements: true,
      conflicts: true,
    });
    expect(body.saves).toHaveLength(72);
    expect(body.scores).toHaveLength(200);
    expect(body.achievements).toHaveLength(500);
    expect(body.conflicts).toHaveLength(100);
    expect(saves.limit).toHaveBeenCalledWith(73);
    expect(scores.limit).toHaveBeenCalledWith(201);
    expect(achievements.limit).toHaveBeenCalledWith(501);
    expect(conflicts.limit).toHaveBeenCalledWith(101);
  });

  it("fails closed when a state-bearing bootstrap response exceeds its byte limit", async () => {
    const profile = {
      select: vi.fn(),
      eq: vi.fn(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    };
    profile.select.mockReturnValue(profile);
    profile.eq.mockReturnValue(profile);
    const branchState = { payload: "x".repeat(120 * 1024) };
    const conflicts = scopedRows(Array.from({ length: 20 }, (_, index) => ({
      ...conflictRow(index),
      id: `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`,
      local_state: branchState,
      server_state: branchState,
    })));
    const from = vi.fn((table: string) => ({
      game_profiles: profile,
      game_saves: scopedRows(),
      game_scores: scopedRows(),
      game_achievements: scopedRows(),
      game_save_conflicts: conflicts,
    })[table]);
    mocks.createClient.mockResolvedValue(session(USER_ID, from));

    const response = await bootstrapGET(new NextRequest(
      "http://axis.test/api/vector/bootstrap?gameId=second-sense&includeState=1",
    ));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "VECTOR_BOOTSTRAP_RESPONSE_TOO_LARGE",
    });
    expect(JSON.stringify(branchState).length * 40).toBeGreaterThan(
      VECTOR_BOOTSTRAP_MAX_RESPONSE_BYTES,
    );
    expect(mocks.captureRouteError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ code: "VECTOR_BOOTSTRAP_RESPONSE_TOO_LARGE" }),
    );
  });

  it("enforces the sync body limit before service-role access", async () => {
    mocks.createClient.mockResolvedValue(session(USER_ID));
    const response = await syncPOST(jsonRequest(
      "http://axis.test/api/vector/sync",
      {},
      { "content-length": String(VECTOR_SYNC_MAX_BODY_BYTES + 1) },
    ));
    expect(response.status).toBe(413);
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
  });

  it("rate-limits sync by authenticated owner before parsing or service-role access", async () => {
    mocks.createClient.mockResolvedValue(session(USER_ID));
    mocks.redisRateLimit.mockResolvedValue({ success: false });

    const response = await syncPOST(jsonRequest(
      "http://axis.test/api/vector/sync",
      { intentionally: "not parsed" },
    ));

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({ error: "VECTOR_RATE_LIMITED" });
    expect(mocks.redisRateLimit).toHaveBeenCalledWith(
      USER_ID,
      120,
      "1 m",
      "axis:vector-sync",
    );
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
  });

  it("strictly rejects client-supplied ownership and fails closed without service role", async () => {
    mocks.createClient.mockResolvedValue(session(USER_ID));
    const base = {
      gameId: "second-sense",
      deviceId: "device-12345678",
      saves: [],
      events: [{
        kind: "achievement",
        idempotencyKey: "44444444-4444-4444-8444-444444444444",
        localRevision: 1,
        occurredAt: new Date().toISOString(),
        payload: { achievementId: "first-run" },
      }],
    };
    const injected = await syncPOST(jsonRequest(
      "http://axis.test/api/vector/sync",
      { ...base, userId: "22222222-2222-4222-8222-222222222222" },
    ));
    expect(injected.status).toBe(400);
    const unavailable = await syncPOST(jsonRequest(
      "http://axis.test/api/vector/sync",
      base,
    ));
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toMatchObject({
      error: "VECTOR_SYNC_UNAVAILABLE",
    });
  });

  it("derives RPC ownership from the authenticated session", async () => {
    const saves = limitedRows();
    const conflicts = limitedRows();
    const from = vi.fn((table: string) => (
      table === "game_saves" ? saves : conflicts
    ));
    const rpc = vi.fn().mockResolvedValue({
      data: {
        idempotencyKey: "44444444-4444-4444-8444-444444444444",
        kind: "achievement",
        status: "applied",
        code: null,
        slotId: null,
        localRevision: 1,
        serverRevision: null,
        conflictId: null,
      },
      error: null,
    });
    mocks.createClient.mockResolvedValue(session(USER_ID, from));
    mocks.createAdminClient.mockReturnValue({ rpc });

    const response = await syncPOST(jsonRequest(
      "http://axis.test/api/vector/sync",
      {
        gameId: "second-sense",
        deviceId: "device-12345678",
        saves: [],
        events: [{
          kind: "achievement",
          idempotencyKey: "44444444-4444-4444-8444-444444444444",
          localRevision: 1,
          occurredAt: new Date().toISOString(),
          payload: { achievementId: "first-run" },
        }],
      },
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ partial: false });
    expect(rpc).toHaveBeenCalledWith("apply_vector_event", expect.objectContaining({
      p_user_id: USER_ID,
      p_game_id: "second-sense",
      p_device_id: "device-12345678",
    }));
  });

  it("marks an applied sync partial when its refreshed truth is truncated", async () => {
    const saves = limitedRows(Array.from({ length: 9 }, (_, index) => saveRow(index)));
    const conflicts = limitedRows(
      Array.from({ length: 33 }, (_, index) => conflictRow(index)),
    );
    const from = vi.fn((table: string) => (
      table === "game_saves" ? saves : conflicts
    ));
    const idempotencyKey = "44444444-4444-4444-8444-444444444444";
    const rpc = vi.fn().mockResolvedValue({
      data: {
        idempotencyKey,
        kind: "achievement",
        status: "applied",
        code: null,
        slotId: null,
        localRevision: 1,
        serverRevision: null,
        conflictId: null,
      },
      error: null,
    });
    mocks.createClient.mockResolvedValue(session(USER_ID, from));
    mocks.createAdminClient.mockReturnValue({ rpc });

    const response = await syncPOST(jsonRequest(
      "http://axis.test/api/vector/sync",
      {
        gameId: "second-sense",
        deviceId: "device-12345678",
        saves: [],
        events: [{
          kind: "achievement",
          idempotencyKey,
          localRevision: 1,
          occurredAt: NOW,
          payload: { achievementId: "first-run" },
        }],
      },
    ));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.partial).toBe(true);
    expect(body.truncated).toEqual({ saves: true, conflicts: true });
    expect(body.saves).toHaveLength(8);
    expect(body.conflicts).toHaveLength(32);
    expect(saves.limit).toHaveBeenCalledWith(9);
    expect(conflicts.limit).toHaveBeenCalledWith(33);
  });

  it("returns partial truth for a checksum rejection without calling the save RPC", async () => {
    const saves = limitedRows();
    const conflicts = limitedRows();
    mocks.createClient.mockResolvedValue(session(
      USER_ID,
      vi.fn((table: string) => (table === "game_saves" ? saves : conflicts)),
    ));
    const rpc = vi.fn();
    mocks.createAdminClient.mockReturnValue({ rpc });

    const response = await syncPOST(jsonRequest(
      "http://axis.test/api/vector/sync",
      {
        gameId: "second-sense",
        deviceId: "device-12345678",
        saves: [{
          idempotencyKey: "44444444-4444-4444-8444-444444444444",
          slotId: "main",
          gameVersion: "1.0.0",
          saveSchemaVersion: 1,
          expectedServerRevision: 0,
          localRevision: 1,
          checksum: "0".repeat(64),
          seed: null,
          state: { round: 1 },
          updatedAt: new Date().toISOString(),
        }],
        events: [],
      },
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      partial: true,
      results: [{
        status: "rejected",
        code: "VECTOR_CHECKSUM_MISMATCH",
      }],
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("returns partial truth for a save compare-and-swap conflict", async () => {
    const saves = limitedRows();
    const conflicts = limitedRows();
    mocks.createClient.mockResolvedValue(session(
      USER_ID,
      vi.fn((table: string) => (table === "game_saves" ? saves : conflicts)),
    ));
    const state = { round: 1 };
    const checksum = await checksumVectorState(state);
    const idempotencyKey = "44444444-4444-4444-8444-444444444444";
    const rpc = vi.fn().mockResolvedValue({
      data: {
        idempotencyKey,
        kind: "save",
        status: "conflict",
        code: "VECTOR_REVISION_MISMATCH",
        slotId: "main",
        localRevision: 2,
        serverRevision: 1,
        conflictId: CONFLICT_ID,
      },
      error: null,
    });
    mocks.createAdminClient.mockReturnValue({ rpc });

    const response = await syncPOST(jsonRequest(
      "http://axis.test/api/vector/sync",
      {
        gameId: "second-sense",
        deviceId: "device-12345678",
        saves: [{
          idempotencyKey,
          slotId: "main",
          gameVersion: "1.0.0",
          saveSchemaVersion: 1,
          expectedServerRevision: 0,
          localRevision: 2,
          checksum,
          seed: null,
          state,
          updatedAt: NOW,
        }],
        events: [],
      },
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      partial: true,
      results: [{ status: "conflict", conflictId: CONFLICT_ID }],
    });
  });

  it("returns not-found for a conflict outside the authenticated owner scope", async () => {
    const builder = {
      select: vi.fn(),
      eq: vi.fn(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    };
    builder.select.mockReturnValue(builder);
    builder.eq.mockReturnValue(builder);
    mocks.createClient.mockResolvedValue(session(USER_ID, vi.fn().mockReturnValue(builder)));
    const response = await conflictPATCH(
      new NextRequest(`http://axis.test/api/vector/conflicts/${CONFLICT_ID}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: "55555555-5555-4555-8555-555555555555",
          expectedConflictVersion: 1,
          resolution: "accept-server",
        }),
      }),
      { params: Promise.resolve({ id: CONFLICT_ID }) },
    );
    expect(response.status).toBe(404);
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
  });

  it("delegates conflict retries to the idempotent RPC after ownership verification", async () => {
    const builder = {
      select: vi.fn(),
      eq: vi.fn(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: {
          id: CONFLICT_ID,
          game_id: "second-sense",
          slot_id: "primary",
        },
        error: null,
      }),
    };
    builder.select.mockReturnValue(builder);
    builder.eq.mockReturnValue(builder);
    const rpc = vi.fn().mockResolvedValue({
      data: {
        idempotencyKey: "55555555-5555-4555-8555-555555555555",
        kind: "save",
        status: "rejected",
        code: "VECTOR_CONFLICT_VERSION_MISMATCH",
        slotId: "primary",
        localRevision: null,
        serverRevision: null,
        conflictId: CONFLICT_ID,
      },
      error: null,
    });
    mocks.createClient.mockResolvedValue(
      session(USER_ID, vi.fn().mockReturnValue(builder)),
    );
    mocks.createAdminClient.mockReturnValue({ rpc });

    const response = await conflictPATCH(
      new NextRequest(`http://axis.test/api/vector/conflicts/${CONFLICT_ID}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: "55555555-5555-4555-8555-555555555555",
          expectedConflictVersion: 1,
          resolution: "accept-server",
        }),
      }),
      { params: Promise.resolve({ id: CONFLICT_ID }) },
    );

    expect(response.status).toBe(409);
    expect(rpc).toHaveBeenCalledWith("resolve_vector_conflict", expect.objectContaining({
      p_user_id: USER_ID,
      p_conflict_id: CONFLICT_ID,
      p_expected_conflict_version: 1,
      p_resolution: "accept-server",
    }));
  });

  it("returns refreshed truth for an idempotent retry of an already-resolved conflict", async () => {
    const ownerBuilder = {
      select: vi.fn(),
      eq: vi.fn(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: {
          id: CONFLICT_ID,
          game_id: "second-sense",
          slot_id: "primary",
        },
        error: null,
      }),
    };
    ownerBuilder.select.mockReturnValue(ownerBuilder);
    ownerBuilder.eq.mockReturnValue(ownerBuilder);

    const conflictBuilder = {
      select: vi.fn(),
      eq: vi.fn(),
      single: vi.fn().mockResolvedValue({
        data: {
          id: CONFLICT_ID,
          user_id: USER_ID,
          game_id: "second-sense",
          slot_id: "primary",
          reason: "revision_mismatch",
          conflict_version: 2,
          status: "resolved",
          resolution: "accept-server",
          local_revision: 2,
          local_game_version: "1.0.0",
          local_save_schema_version: 1,
          local_checksum: "1".repeat(64),
          local_seed: null,
          local_state: { round: 2 },
          local_updated_at: "2026-07-16T10:00:00.000Z",
          server_revision: 1,
          server_game_version: "1.0.0",
          server_save_schema_version: 1,
          server_checksum: "2".repeat(64),
          server_seed: null,
          server_state: { round: 1 },
          server_updated_at: "2026-07-16T09:00:00.000Z",
          created_at: "2026-07-16T10:00:00.000Z",
          resolved_at: "2026-07-16T10:01:00.000Z",
        },
        error: null,
      }),
    };
    conflictBuilder.select.mockReturnValue(conflictBuilder);
    conflictBuilder.eq.mockReturnValue(conflictBuilder);

    const savesBuilder = {
      select: vi.fn(),
      eq: vi.fn(),
      in: vi.fn(),
      is: vi.fn().mockResolvedValue({ data: [], error: null }),
    };
    savesBuilder.select.mockReturnValue(savesBuilder);
    savesBuilder.eq.mockReturnValue(savesBuilder);
    savesBuilder.in.mockReturnValue(savesBuilder);

    let conflictRead = 0;
    const from = vi.fn((table: string) => {
      if (table === "game_save_conflicts") {
        conflictRead += 1;
        return conflictRead === 1 ? ownerBuilder : conflictBuilder;
      }
      return savesBuilder;
    });
    const rpc = vi.fn().mockResolvedValue({
      data: {
        idempotencyKey: "55555555-5555-4555-8555-555555555555",
        kind: "save",
        status: "duplicate",
        code: null,
        slotId: "primary",
        localRevision: 2,
        serverRevision: 1,
        conflictId: CONFLICT_ID,
      },
      error: null,
    });
    mocks.createClient.mockResolvedValue(session(USER_ID, from));
    mocks.createAdminClient.mockReturnValue({ rpc });

    const response = await conflictPATCH(
      new NextRequest(`http://axis.test/api/vector/conflicts/${CONFLICT_ID}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: "55555555-5555-4555-8555-555555555555",
          expectedConflictVersion: 1,
          resolution: "accept-server",
        }),
      }),
      { params: Promise.resolve({ id: CONFLICT_ID }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      result: { status: "duplicate", code: null },
      conflict: { id: CONFLICT_ID, status: "resolved" },
      saves: [],
    });
  });
});
