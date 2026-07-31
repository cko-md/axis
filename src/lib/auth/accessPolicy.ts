/**
 * Exact middleware access policy. Unknown application and API paths are
 * authenticated by default; exceptions are limited to routes with an
 * independently verified authority or an intentional pre-login flow.
 */
export type AccessClass =
  | "authenticated"
  | "public-page"
  | "static-public-page"
  | "keyless-public"
  | "service-auth"
  | "telemetry-ingest"
  | "mfa-bootstrap";

function canonicalPair(pathname: string): string[] {
  return [pathname, `${pathname}/`];
}

const STATIC_PUBLIC_PAGES = new Set([
  "/",
  ...canonicalPair("/terms"),
  ...canonicalPair("/privacy"),
  ...canonicalPair("/oauth-done"),
]);
const AUTH_AWARE_PUBLIC_PAGES = new Set([
  ...canonicalPair("/login"),
  ...canonicalPair("/auth/callback"),
]);
const KEYLESS_PUBLIC_API = new Set([
  "/api/auth/forgot-password",
  "/api/auth/passkey/authenticate",
  "/api/spotify/callback",
]);
const SERVICE_AUTH_API = new Set([
  "/api/plaid/webhook",
  "/api/webhooks/make",
  "/api/cron/daily",
  "/api/cron/feed-digest",
  "/api/cron/finance-daily",
  "/api/cron/intelligence-sweep",
]);
// Sentry's configured tunnelRoute is injected as a build-time rewrite, so it
// has no handwritten route module to inventory. The exact ingress paths bypass
// session refresh so client error reporting remains available during an auth
// outage. Sentry middleware auto-instrumentation is disabled in next.config.ts:
// its installed wrapper would otherwise bypass AXIS middleware for descendants.
const TELEMETRY_INGRESS_PATHS = new Set(["/monitoring", "/monitoring/"]);
const MFA_BOOTSTRAP_API = new Set([
  "/api/auth/mfa/challenge",
  "/api/auth/mfa/verify",
  "/api/auth/mfa/trust-device",
]);

export function classifyAccess(pathname: string): AccessClass {
  if (MFA_BOOTSTRAP_API.has(pathname)) return "mfa-bootstrap";
  if (KEYLESS_PUBLIC_API.has(pathname)) return "keyless-public";
  if (SERVICE_AUTH_API.has(pathname)) return "service-auth";
  if (TELEMETRY_INGRESS_PATHS.has(pathname)) return "telemetry-ingest";
  if (pathname.startsWith("/api/")) return "authenticated";
  if (STATIC_PUBLIC_PAGES.has(pathname)) return "static-public-page";
  if (AUTH_AWARE_PUBLIC_PAGES.has(pathname)) return "public-page";
  return "authenticated";
}

export function requiresSupabaseAuth(access: AccessClass): boolean {
  return access !== "service-auth"
    && access !== "telemetry-ingest"
    && access !== "static-public-page";
}
