import { type NextRequest } from "next/server";
import { optionalEnv } from "@/lib/env";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// OAuth providers require an EXACT string match on redirect_uri, and several
// (Spotify's April 2025 policy, notably) only exempt the literal loopback IP
// (127.0.0.1) from their HTTPS requirement — "localhost" is NOT accepted as
// that exception. That makes NEXT_PUBLIC_APP_URL a trap in local dev: whichever
// single host you hardcode there (localhost vs 127.0.0.1) works for providers
// registered against that host and permanently 400s for any provider
// registered against the other, even though both resolve to the same machine.
//
// For loopback requests, prefer the RAW `Host` header over both the
// configured env var and req.nextUrl. Next.js's NextURL unconditionally
// regex-rewrites 127.0.0.1 / [::1] to the literal string "localhost" at parse
// time (see REGEX_LOCALHOST_HOSTNAME in next/dist/server/web/next-url.js) —
// every version of req.nextUrl.hostname/.origin already lost the distinction
// the client actually asked for, in every environment, always. The `Host`
// header is untouched by that rewrite, so it's the only reliable way to see
// what the browser's address bar actually said.
export function getAppOrigin(req: NextRequest): string {
  const configured = optionalEnv("NEXT_PUBLIC_APP_URL")?.replace(/\/$/, "");
  const rawHost = req.headers.get("host");
  if (configured && rawHost) {
    const hostname = rawHost.startsWith("[")
      ? rawHost.slice(0, rawHost.indexOf("]") + 1)
      : rawHost.split(":")[0];
    if (LOOPBACK_HOSTS.has(hostname)) {
      return `${req.nextUrl.protocol}//${rawHost}`;
    }
  }
  return configured ?? req.nextUrl.origin;
}

// Builds an absolute same-app URL (path + optional query) for a redirect,
// e.g. `new URL("/oauth-done?status=ok", getAppOrigin(req))`.
//
// This is NOT equivalent to `new URL(pathAndQuery, req.url)`, the pattern
// used throughout the OAuth callback routes — req.url suffers the exact same
// corruption as req.nextUrl (NextRequest's constructor literally sets
// `this.url = nextUrl.toString()` by default; see next/dist/server/web/
// spec-extension/request.js), so building a redirect target from req.url
// silently bounces a 127.0.0.1 request to a "localhost" redirect target,
// landing the browser on a different origin mid-OAuth-flow (breaking the
// popup's window.opener postMessage handshake and dropping any origin-scoped
// session state). Always build redirect targets from this helper instead.
export function buildAppUrl(req: NextRequest, pathAndQuery: string): URL {
  return new URL(pathAndQuery, getAppOrigin(req));
}
