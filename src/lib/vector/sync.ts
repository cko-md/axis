import {
  vectorBootstrapResponseSchema,
  vectorConflictResolutionResponseSchema,
  vectorConflictResolutionSchema,
  vectorSyncResponseSchema,
  type VectorBootstrapResponse,
  type VectorConflictResolution,
  type VectorConflictResolutionResponse,
  type VectorSyncResponse,
} from "@/lib/vector/contracts";
import type { VectorOwnerKey } from "@/lib/vector/persistence-types";
import {
  VectorPersistenceError,
  VectorPersistence,
  type VectorSyncSnapshot,
} from "@/lib/vector/persistence";
import type { VectorGameSlug } from "@/lib/vector/types";

export type VectorSyncOutcome =
  | { status: "idle" }
  | { status: "synced"; response: VectorSyncResponse }
  | { status: "partial"; response: VectorSyncResponse; code: "VECTOR_SYNC_PARTIAL" }
  | { status: "error"; code: string; retryable: boolean };

export type VectorBootstrapOutcome =
  | { status: "loaded"; response: VectorBootstrapResponse }
  | {
      status: "partial";
      response: VectorBootstrapResponse;
      code: "VECTOR_BOOTSTRAP_PARTIAL";
    }
  | { status: "error"; code: string; retryable: boolean };

export type VectorConflictResolutionOutcome =
  | { status: "resolved"; response: VectorConflictResolutionResponse }
  | { status: "error"; code: string; retryable: boolean };

function ownerChanged(
  persistence: VectorPersistence,
  expectedOwner: VectorOwnerKey,
): boolean {
  return persistence.getActiveOwner() !== expectedOwner;
}

function responseCode(status: number): string {
  if (status === 401) return "VECTOR_UNAUTHORIZED";
  if (status === 413) return "VECTOR_SYNC_TOO_LARGE";
  if (status === 429) return "VECTOR_RATE_LIMITED";
  if (status === 503) return "VECTOR_SYNC_UNAVAILABLE";
  return `VECTOR_SYNC_HTTP_${status}`;
}

function localFailureCode(error: unknown, fallback: string): string {
  if (error instanceof VectorPersistenceError) return error.code;
  if (error instanceof Error && /^VECTOR_[A-Z0-9_]+$/.test(error.message)) {
    return error.message;
  }
  return fallback;
}

export async function syncVectorGame(input: {
  repository: VectorPersistence;
  ownerKey: VectorOwnerKey;
  gameId: VectorGameSlug;
  deviceId: string;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
}): Promise<VectorSyncOutcome> {
  const fetcher = input.fetcher ?? fetch;
  const maxBatches = 32;
  let lastResponse: VectorSyncResponse | null = null;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    let snapshot: VectorSyncSnapshot | null;
    try {
      snapshot = await input.repository.createSyncSnapshot(
        input.ownerKey,
        input.gameId,
        input.deviceId,
      );
    } catch (error) {
      const localCode = localFailureCode(error, "VECTOR_SYNC_PREPARE_FAILED");
      return {
        status: "error",
        code: localCode === "VECTOR_OWNER_INACTIVE" ? "VECTOR_OWNER_CHANGED" : localCode,
        retryable: (
          localCode !== "VECTOR_OWNER_INACTIVE" &&
          localCode !== "VECTOR_EVENT_CORRUPT"
        ),
      };
    }
    if (!snapshot) {
      return lastResponse
        ? { status: "synced", response: lastResponse }
        : { status: "idle" };
    }
    let phase: "transport" | "apply" = "transport";
    try {
      const response = await fetcher("/api/vector/sync", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(snapshot.body),
        signal: input.signal,
      });
      if (!response.ok) {
        if (ownerChanged(input.repository, input.ownerKey)) {
          return { status: "error", code: "VECTOR_OWNER_CHANGED", retryable: false };
        }
        const code = responseCode(response.status);
        await input.repository.markSyncFailed(snapshot, input.ownerKey, code);
        return {
          status: "error",
          code,
          retryable: response.status >= 500 || response.status === 429,
        };
      }
      const parsed = vectorSyncResponseSchema.safeParse(await response.json());
      if (!parsed.success) {
        if (ownerChanged(input.repository, input.ownerKey)) {
          return { status: "error", code: "VECTOR_OWNER_CHANGED", retryable: false };
        }
        await input.repository.markSyncFailed(
          snapshot,
          input.ownerKey,
          "VECTOR_SYNC_RESPONSE_INVALID",
        );
        return { status: "error", code: "VECTOR_SYNC_RESPONSE_INVALID", retryable: true };
      }
      if (ownerChanged(input.repository, input.ownerKey)) {
        return { status: "error", code: "VECTOR_OWNER_CHANGED", retryable: false };
      }
      phase = "apply";
      await input.repository.applySyncResponse(input.ownerKey, snapshot, parsed.data);
      lastResponse = parsed.data;
      const partial = parsed.data.partial || parsed.data.results.some((result) => (
        result.status === "rejected" || result.status === "conflict"
      ));
      if (partial) {
        return { status: "partial", response: parsed.data, code: "VECTOR_SYNC_PARTIAL" };
      }
    } catch (error) {
      const localCode = localFailureCode(error, "");
      if (
        ownerChanged(input.repository, input.ownerKey) ||
        localCode === "VECTOR_OWNER_INACTIVE"
      ) {
        return { status: "error", code: "VECTOR_OWNER_CHANGED", retryable: false };
      }
      const code = phase === "apply"
        ? localFailureCode(error, "VECTOR_SYNC_APPLY_FAILED")
        : error instanceof DOMException && error.name === "AbortError"
          ? "VECTOR_SYNC_ABORTED"
          : "VECTOR_SYNC_NETWORK";
      try {
        await input.repository.markSyncFailed(snapshot, input.ownerKey, code);
      } catch (markError) {
        const markCode = localFailureCode(markError, "VECTOR_SYNC_FAILURE_STATE_UNAVAILABLE");
        return {
          status: "error",
          code: markCode === "VECTOR_OWNER_INACTIVE" ? "VECTOR_OWNER_CHANGED" : markCode,
          retryable: markCode !== "VECTOR_OWNER_INACTIVE",
        };
      }
      return { status: "error", code, retryable: code !== "VECTOR_SYNC_ABORTED" };
    }
  }
  if (!lastResponse) return { status: "idle" };
  try {
    const remaining = await input.repository.countPendingSyncWork(input.ownerKey, input.gameId);
    return remaining > 0
      ? { status: "partial", response: lastResponse, code: "VECTOR_SYNC_PARTIAL" }
      : { status: "synced", response: lastResponse };
  } catch (error) {
    const code = localFailureCode(error, "VECTOR_SYNC_VERIFY_FAILED");
    return {
      status: "error",
      code: code === "VECTOR_OWNER_INACTIVE" ? "VECTOR_OWNER_CHANGED" : code,
      retryable: code !== "VECTOR_OWNER_INACTIVE",
    };
  }
}

export async function bootstrapVectorCloud(input: {
  persistence: VectorPersistence;
  ownerKey: VectorOwnerKey;
  deviceId: string;
  gameId?: VectorGameSlug;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
}): Promise<VectorBootstrapOutcome> {
  const query = new URLSearchParams({ includeState: input.gameId ? "1" : "0" });
  if (input.gameId) query.set("gameId", input.gameId);
  const fetcher = input.fetcher ?? fetch;
  let phase: "transport" | "apply" = "transport";
  try {
    const response = await fetcher(`/api/vector/bootstrap?${query}`, {
      method: "GET",
      credentials: "same-origin",
      signal: input.signal,
    });
    if (!response.ok) {
      return {
        status: "error",
        code: responseCode(response.status),
        retryable: response.status >= 500 || response.status === 429,
      };
    }
    const parsed = vectorBootstrapResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      return {
        status: "error",
        code: "VECTOR_BOOTSTRAP_RESPONSE_INVALID",
        retryable: true,
      };
    }
    if (ownerChanged(input.persistence, input.ownerKey)) {
      return { status: "error", code: "VECTOR_OWNER_CHANGED", retryable: false };
    }
    phase = "apply";
    await input.persistence.applyBootstrap(
      input.ownerKey,
      input.deviceId,
      parsed.data,
      input.gameId,
    );
    return Object.values(parsed.data.truncated).some(Boolean)
      ? {
          status: "partial",
          response: parsed.data,
          code: "VECTOR_BOOTSTRAP_PARTIAL",
        }
      : { status: "loaded", response: parsed.data };
  } catch (error) {
    if (ownerChanged(input.persistence, input.ownerKey)) {
      return { status: "error", code: "VECTOR_OWNER_CHANGED", retryable: false };
    }
    const code = phase === "apply"
      ? localFailureCode(error, "VECTOR_BOOTSTRAP_APPLY_FAILED")
      : error instanceof DOMException && error.name === "AbortError"
        ? "VECTOR_BOOTSTRAP_ABORTED"
        : "VECTOR_BOOTSTRAP_NETWORK";
    return { status: "error", code, retryable: code !== "VECTOR_BOOTSTRAP_ABORTED" };
  }
}

export async function resolveVectorCloudConflict(input: {
  conflictId: string;
  idempotencyKey: string;
  resolution: Omit<VectorConflictResolution, "idempotencyKey">;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
}): Promise<VectorConflictResolutionOutcome> {
  const body = vectorConflictResolutionSchema.safeParse({
    idempotencyKey: input.idempotencyKey,
    ...input.resolution,
  });
  if (!body.success || !/^[0-9a-f-]{36}$/i.test(input.conflictId)) {
    return { status: "error", code: "VECTOR_CONFLICT_INPUT_INVALID", retryable: false };
  }
  const fetcher = input.fetcher ?? fetch;
  try {
    const response = await fetcher(
      `/api/vector/conflicts/${encodeURIComponent(input.conflictId)}`,
      {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body.data),
        signal: input.signal,
      },
    );
    if (!response.ok) {
      let code = responseCode(response.status);
      try {
        const payload = await response.json() as { error?: unknown };
        if (typeof payload.error === "string" && /^VECTOR_[A-Z0-9_]+$/.test(payload.error)) {
          code = payload.error;
        }
      } catch {
        // The status-derived code remains safe and actionable.
      }
      return {
        status: "error",
        code,
        retryable: response.status >= 500 || response.status === 429,
      };
    }
    const parsed = vectorConflictResolutionResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      return {
        status: "error",
        code: "VECTOR_CONFLICT_RESPONSE_INVALID",
        retryable: true,
      };
    }
    return { status: "resolved", response: parsed.data };
  } catch (error) {
    const code = error instanceof DOMException && error.name === "AbortError"
      ? "VECTOR_CONFLICT_ABORTED"
      : "VECTOR_CONFLICT_NETWORK";
    return { status: "error", code, retryable: code !== "VECTOR_CONFLICT_ABORTED" };
  }
}

export function transmittedSave(
  snapshot: VectorSyncSnapshot,
  slotId: string,
): { slotId: string; localRevision: number; idempotencyKey: string } | null {
  return snapshot.transmittedSaves.find((save) => save.slotId === slotId) ?? null;
}
