import type { Integration } from "@sentry/core";

const BLOCKED_INTEGRATIONS = new Set([
  "BrowserTracing",
  "WebVitals",
  "SpanStreaming",
  "FetchStreamPerformance",
  "BrowserSession",
  "ProcessSession",
]);

/** Remove every integration which can emit non-error envelopes or spans. */
export function filterAxisErrorOnlyIntegrations(integrations: Integration[]): Integration[] {
  return integrations.filter((integration) => {
    const name = integration.name.replace(/Integration$/, "");
    return !BLOCKED_INTEGRATIONS.has(name);
  });
}
