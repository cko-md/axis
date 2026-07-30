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
  let provider: "youtube" | undefined;
  try {
    const host = new URL(rawTarget).hostname.toLowerCase().replace(/\.+$/, "");
    if (host === "www.youtube.com") provider = "youtube";
  } catch {
    // Invalid input contributes no identifier at all.
  }

  const code = error instanceof SafeFetchError ? error.code : "SAFE_FETCH_ROUTE_FAILED";
  const data = { operation, code, ...(provider ? { provider } : {}) };
  const isSafeFetchError = error instanceof SafeFetchError;
  Sentry.addBreadcrumb({ category: "safe-fetch", level: isSafeFetchError ? "info" : "error", data });
  if (!isSafeFetchError || EVENT_WORTHY_CODES.has(code)) {
    Sentry.captureException(new Error(code), { tags: { area: "safe-fetch", ...data } });
  }
  return { code };
}
