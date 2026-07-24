/**
 * Exact middleware access policy. Unknown API paths are authenticated by
 * default; every exception documents which lower-layer authority owns it.
 */
export type AccessClass =
  | "authenticated"
  | "public-page"
  | "static-public-page"
  | "keyless-public"
  | "service-auth"
  | "mfa-bootstrap";

const STATIC_PUBLIC_PAGES = new Set(["/", "/terms", "/privacy", "/oauth-done"]);
const AUTH_AWARE_PUBLIC_PAGES = new Set(["/login", "/auth/callback"]);
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

export function classifyAccess(pathname: string): AccessClass {
  if (
    pathname === "/api/auth/mfa/challenge"
    || pathname === "/api/auth/mfa/verify"
    || pathname === "/api/auth/mfa/trust-device"
  ) {
    return "mfa-bootstrap";
  }
  if (KEYLESS_PUBLIC_API.has(pathname)) return "keyless-public";
  if (SERVICE_AUTH_API.has(pathname)) return "service-auth";
  if (pathname.startsWith("/api/")) return "authenticated";
  if (STATIC_PUBLIC_PAGES.has(pathname)) return "static-public-page";
  if (AUTH_AWARE_PUBLIC_PAGES.has(pathname)) return "public-page";
  return "authenticated";
}

export function requiresSupabaseAuth(access: AccessClass) {
  return access !== "service-auth" && access !== "static-public-page";
}
