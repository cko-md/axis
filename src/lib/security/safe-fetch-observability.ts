import * as Sentry from "@sentry/nextjs";
import { SafeFetchError } from "./safe-fetch";

const EVENT_WORTHY_CODES = new Set([
  "SAFE_FETCH_DNS_FAILED",
  "SAFE_FETCH_TIMEOUT",
  "SAFE_FETCH_TRANSPORT_FAILED",
]);

/**
 * Records outbound-read failures without placing a hostname/IP, URL, query
 * string, response body, or request metadata into telemetry. Only explicitly
 * classified provider hosts may contribute a coarse provider label.
 */
export function recordSafeFetchFailure(operation: string, rawTarget: string | URL, error: unknown) {
  return recordSafeFetchFailures(operation, [{ rawTarget, error }])[0] ?? { code: "SAFE_FETCH_ROUTE_FAILED" };
}

type SafeFetchFailure = { rawTarget: string | URL; error: unknown };

type SafeFetchFailureData = { code: string; provider?: "youtube" };

function classifySafeFetchFailure(rawTarget: string | URL, error: unknown): SafeFetchFailureData {
  let provider: "youtube" | undefined;
  try {
    const host = new URL(rawTarget).hostname.toLowerCase().replace(/\.+$/, "");
    if (host === "www.youtube.com") provider = "youtube";
  } catch {
    // Invalid input contributes no identifier at all.
  }

  const code = error instanceof SafeFetchError ? error.code : "SAFE_FETCH_ROUTE_FAILED";
  return { code, ...(provider ? { provider } : {}) };
}

/**
 * Records all failures as safe breadcrumbs, but emits at most one searchable
 * event for a batch route invocation. Callers keep one normalized code per
 * failed source without creating six near-identical Sentry issues.
 */
export function recordSafeFetchFailures(operation: string, failures: readonly SafeFetchFailure[]) {
  const classified = failures.map(({ rawTarget, error }) => ({
    error,
    data: classifySafeFetchFailure(rawTarget, error),
  }));
  for (const { error, data } of classified) {
    Sentry.addBreadcrumb({ category: "safe-fetch", level: error instanceof SafeFetchError ? "info" : "error", data: { operation, ...data } });
  }
  const searchable = classified.find(({ error, data }) => !(error instanceof SafeFetchError) || EVENT_WORTHY_CODES.has(data.code));
  if (searchable) {
    Sentry.captureException(new Error(searchable.data.code), { tags: { area: "safe-fetch", operation, ...searchable.data } });
  }
  return classified.map(({ data }) => data);
}
