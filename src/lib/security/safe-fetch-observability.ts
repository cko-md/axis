import * as Sentry from "@sentry/nextjs";
import { SafeFetchError } from "./safe-fetch";

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
  Sentry.addBreadcrumb({ category: "safe-fetch", level: error instanceof SafeFetchError ? "info" : "error", data });
  if (!(error instanceof SafeFetchError)) {
    Sentry.captureException(new Error(code), { tags: { area: "safe-fetch", ...data } });
  }
  return { code };
}
