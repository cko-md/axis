import { createHmac, randomBytes } from "node:crypto";
import { privateJson } from "@/lib/auth/privateNoStore";
import { optionalEnv } from "@/lib/env";
import { captureRouteError } from "@/lib/observability/captureRouteError";

export type DirectProviderRefreshCode =
  | "PROVIDER_REFRESH_TIMEOUT"
  | "PROVIDER_REFRESH_UNAVAILABLE"
  | "PROVIDER_REFRESH_INVALID_RESPONSE"
  | "PROVIDER_REFRESH_IN_PROGRESS"
  | "PROVIDER_REFRESH_COORDINATOR_UNAVAILABLE"
  | "PROVIDER_COOKIE_KEY_NOT_CONFIGURED";

export class DirectProviderRefreshError extends Error {
  readonly provider: "spotify" | "strava";
  readonly status: 409 | 502 | 503 | 504;
  readonly code: DirectProviderRefreshCode;

  constructor(options: {
    provider: "spotify" | "strava";
    status: 409 | 502 | 503 | 504;
    code: DirectProviderRefreshCode;
    cause?: unknown;
  }) {
    super(`${options.provider} credential refresh failed`, {
      ...(options.cause === undefined ? {} : { cause: options.cause }),
    });
    this.name = "DirectProviderRefreshError";
    this.provider = options.provider;
    this.status = options.status;
    this.code = options.code;
  }
}

const REFRESH_LEASE_TTL_MS = 60_000;
const REFRESH_CONSUMED_TTL_SECONDS = 60;
const testLocks = new Set<string>();
const testConsumed = new Map<string, number>();

type RefreshCoordinator = {
  exists(key: string): Promise<number>;
  set(
    key: string,
    value: string,
    options: { nx?: true; px?: number; ex?: number },
  ): Promise<unknown>;
  eval(
    script: string,
    keys: string[],
    args: string[],
  ): Promise<unknown>;
};

let testCoordinator: RefreshCoordinator | null = null;

/** Injects the production coordinator protocol without network access in tests. */
export function setDirectProviderRefreshCoordinatorForTests(
  coordinator: RefreshCoordinator | null,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("DIRECT_PROVIDER_REFRESH_TEST_COORDINATOR_FORBIDDEN");
  }
  testCoordinator = coordinator;
}

export function resetDirectProviderRefreshLeaseTestState(): void {
  if (process.env.NODE_ENV !== "test") return;
  testLocks.clear();
  testConsumed.clear();
  testCoordinator = null;
}

function refreshLeaseKey(options: {
  provider: "spotify" | "strava";
  subject: string;
  refreshToken: string;
  refreshGeneration: string;
  providerState?: string;
}): string {
  // The provider refresh token is already a high-entropy secret. Using it only
  // as the local HMAC key keeps Redis identifiers opaque while making the
  // namespace invariant across AXIS cookie-signing-key rotations.
  const digest = createHmac("sha256", options.refreshToken)
    .update(
      `axis:direct-provider-refresh-lease:v2\0${options.provider}\0${options.subject}\0${options.providerState ?? "subject-slot"}\0${options.refreshGeneration}`,
    )
    .digest("hex");
  return `axis:provider-refresh:v2:${digest}`;
}

function coordinatorCleanupError(
  provider: "spotify" | "strava",
  cause: unknown,
): void {
  const error = new DirectProviderRefreshError({
    provider,
    status: 503,
    code: "PROVIDER_REFRESH_COORDINATOR_UNAVAILABLE",
    cause,
  });
  captureRouteError(error, {
    route: "/internal/direct-provider-refresh",
    area: "integrations",
    provider,
    transport: "direct",
    operation: "release_refresh_lease",
    status: 503,
    code: error.code,
  });
}

async function coordinatedRefresh<T>(
  redis: RefreshCoordinator,
  baseKey: string,
  provider: "spotify" | "strava",
  operation: () => Promise<T>,
): Promise<T> {
  const lockKey = `${baseKey}:lock`;
  const consumedKey = `${baseKey}:consumed`;
  if (await redis.exists(consumedKey)) {
    throw new DirectProviderRefreshError({
      provider,
      status: 409,
      code: "PROVIDER_REFRESH_IN_PROGRESS",
    });
  }
  const owner = randomBytes(18).toString("base64url");
  const acquired = await redis.set(lockKey, owner, {
    nx: true,
    px: REFRESH_LEASE_TTL_MS,
  });
  if (acquired !== "OK") {
    throw new DirectProviderRefreshError({
      provider,
      status: 409,
      code: "PROVIDER_REFRESH_IN_PROGRESS",
    });
  }
  try {
    // Commit the exact generation as consumed before the irreversible provider
    // exchange. Any failure here is still safe to surface because no token has
    // rotated. After this succeeds, cleanup is strictly best-effort.
    const consumed = await redis.set(consumedKey, "1", {
      nx: true,
      ex: REFRESH_CONSUMED_TTL_SECONDS,
    });
    if (consumed !== "OK") {
      throw new DirectProviderRefreshError({
        provider,
        status: 409,
        code: "PROVIDER_REFRESH_IN_PROGRESS",
      });
    }
    return await operation();
  } finally {
    try {
      await redis.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        [lockKey],
        [owner],
      );
    } catch (error) {
      coordinatorCleanupError(provider, error);
    }
  }
}

async function withTestRefreshLease<T>(
  provider: "spotify" | "strava",
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  if ((testConsumed.get(key) ?? 0) > now || testLocks.has(key)) {
    throw new DirectProviderRefreshError({
      provider,
      status: 409,
      code: "PROVIDER_REFRESH_IN_PROGRESS",
    });
  }
  testLocks.add(key);
  testConsumed.set(key, Date.now() + REFRESH_CONSUMED_TTL_SECONDS * 1_000);
  try {
    return await operation();
  } finally {
    testLocks.delete(key);
  }
}

/**
 * Atomically permits one provider exchange for an exact signed credential
 * generation. The completion tombstone outlives the lease so a stale browser
 * request cannot re-enter before the winning Set-Cookie response is applied.
 * No token or raw subject is written to the coordinator.
 */
export async function withDirectProviderRefreshLease<T>(
  options: {
    provider: "spotify" | "strava";
    subject: string;
    refreshToken: string;
    refreshGeneration: string;
    providerState?: string;
  },
  operation: () => Promise<T>,
): Promise<T> {
  const baseKey = refreshLeaseKey(options);
  if (process.env.NODE_ENV === "test" && !testCoordinator) {
    return withTestRefreshLease(options.provider, baseKey, operation);
  }
  if (!testCoordinator && (!optionalEnv("UPSTASH_REDIS_REST_URL") ||
    !optionalEnv("UPSTASH_REDIS_REST_TOKEN"))) {
    throw new DirectProviderRefreshError({
      provider: options.provider,
      status: 503,
      code: "PROVIDER_REFRESH_COORDINATOR_UNAVAILABLE",
    });
  }
  try {
    let redis = testCoordinator;
    if (!redis) {
      const { Redis } = await import("@upstash/redis");
      redis = Redis.fromEnv() as unknown as RefreshCoordinator;
    }
    return await coordinatedRefresh(redis, baseKey, options.provider, operation);
  } catch (error) {
    if (error instanceof DirectProviderRefreshError) throw error;
    throw new DirectProviderRefreshError({
      provider: options.provider,
      status: 503,
      code: "PROVIDER_REFRESH_COORDINATOR_UNAVAILABLE",
      cause: error,
    });
  }
}

export function directProviderRefreshFailureResponse(
  error: unknown,
  route: string,
): Response {
  if (!(error instanceof DirectProviderRefreshError)) throw error;
  captureRouteError(error, {
    route,
    area: "integrations",
    provider: error.provider,
    transport: "direct",
    operation: "refresh_token",
    status: error.status,
    code: error.code,
  });
  return privateJson(
    { error: "PROVIDER_REFRESH_UNAVAILABLE", code: error.code },
    { status: error.status },
  );
}

export function providerRefreshTransportError(
  provider: "spotify" | "strava",
  error: unknown,
): DirectProviderRefreshError {
  const timeout = error instanceof DOMException && error.name === "AbortError";
  return new DirectProviderRefreshError({
    provider,
    status: timeout ? 504 : 502,
    code: timeout ? "PROVIDER_REFRESH_TIMEOUT" : "PROVIDER_REFRESH_UNAVAILABLE",
    cause: error,
  });
}
