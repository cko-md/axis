// Transport-agnostic integration primitives shared by every provider adapter
// (mail today; calendar/contacts next). The goal: every adapter method returns
// the SAME `Result<T>` discriminated union with a SAME-shaped `IntegrationError`,
// so API routes and (eventually) UI never branch on whether an account is
// direct-OAuth or Composio — they branch on a normalized error `code` instead.

/** How a given account reaches its provider. */
export type IntegrationTransport = "direct" | "composio";

/** Product domains that have (or will have) an adapter layer. */
export type IntegrationDomain = "mail" | "calendar" | "contacts";

/**
 * Normalized failure taxonomy. Adapters map provider-specific failures (HTTP
 * status, Composio `successful:false`, thrown errors) onto one of these so
 * callers can react generically: `auth_expired` → prompt reconnect,
 * `rate_limited` → back off, `not_supported` → hide the action, etc.
 */
export type IntegrationErrorCode =
  | "auth_expired"      // token missing/expired/revoked — user must reconnect
  | "rate_limited"      // provider throttled us
  | "not_found"         // the referenced object doesn't exist
  | "not_supported"     // this provider/transport can't perform this operation
  | "invalid_request"   // our call was malformed (bug or bad input)
  | "provider_error"    // provider returned an error we can't classify further
  | "network"           // transport-level failure (timeout, DNS, fetch threw)
  | "unknown";          // anything else

export interface IntegrationError {
  code: IntegrationErrorCode;
  /** Human-readable, safe to surface in a toast. Never contains tokens/PII. */
  message: string;
  /** Whether a retry could plausibly succeed (drives UI "Retry" affordances). */
  retryable: boolean;
  provider?: string;
  transport?: IntegrationTransport;
  /** Upstream HTTP status when known. */
  status?: number;
}

/** Discriminated-union result every adapter method returns. */
export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: IntegrationError };

export function ok<T>(data: T): Result<T> {
  return { ok: true, data };
}

/** Default retry semantics per error code. */
function defaultRetryable(code: IntegrationErrorCode): boolean {
  switch (code) {
    case "rate_limited":
    case "provider_error":
    case "network":
    case "unknown":
      return true;
    default:
      return false;
  }
}

export function makeError(
  code: IntegrationErrorCode,
  message: string,
  extra?: Partial<Pick<IntegrationError, "provider" | "transport" | "status" | "retryable">>,
): IntegrationError {
  return {
    code,
    message,
    retryable: extra?.retryable ?? defaultRetryable(code),
    ...(extra?.provider ? { provider: extra.provider } : {}),
    ...(extra?.transport ? { transport: extra.transport } : {}),
    ...(extra?.status !== undefined ? { status: extra.status } : {}),
  };
}

export function fail<T = never>(
  code: IntegrationErrorCode,
  message: string,
  extra?: Partial<Pick<IntegrationError, "provider" | "transport" | "status" | "retryable">>,
): Result<T> {
  return { ok: false, error: makeError(code, message, extra) };
}

/** Map an upstream HTTP status onto a normalized error code. */
export function codeFromStatus(status: number): IntegrationErrorCode {
  if (status === 401 || status === 403) return "auth_expired";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status === 400 || status === 422) return "invalid_request";
  if (status >= 500) return "provider_error";
  return "unknown";
}

export function failFromStatus<T = never>(
  status: number,
  message: string,
  extra?: Partial<Pick<IntegrationError, "provider" | "transport">>,
): Result<T> {
  return fail<T>(codeFromStatus(status), message, { ...extra, status });
}

/**
 * Turn a thrown value into a structured error. Recognizes ComposioError-shaped
 * objects (a numeric `status`) without importing the class (keeps this file
 * dependency-free and reusable across domains).
 */
export function failFromException<T = never>(
  e: unknown,
  fallbackMessage: string,
  extra?: Partial<Pick<IntegrationError, "provider" | "transport">>,
): Result<T> {
  const status =
    e && typeof e === "object" && "status" in e && typeof (e as { status: unknown }).status === "number"
      ? (e as { status: number }).status
      : undefined;
  const message = e instanceof Error && e.message ? e.message : fallbackMessage;
  if (typeof status === "number") {
    return fail<T>(codeFromStatus(status), message, { ...extra, status });
  }
  // No status → almost always a fetch/timeout/abort.
  return fail<T>("network", message, extra);
}
