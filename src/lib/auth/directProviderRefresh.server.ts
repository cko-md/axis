import { privateJson } from "@/lib/auth/privateNoStore";
import { captureRouteError } from "@/lib/observability/captureRouteError";

export type DirectProviderRefreshCode =
  | "PROVIDER_REFRESH_TIMEOUT"
  | "PROVIDER_REFRESH_UNAVAILABLE"
  | "PROVIDER_REFRESH_INVALID_RESPONSE";

export class DirectProviderRefreshError extends Error {
  readonly provider: "spotify" | "strava";
  readonly status: 502 | 504;
  readonly code: DirectProviderRefreshCode;

  constructor(options: {
    provider: "spotify" | "strava";
    status: 502 | 504;
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
