/**
 * Shared SSRF guard. Blocks server-side fetches from reaching localhost,
 * RFC1918 private ranges, link-local cloud metadata services, internal-only
 * hostnames, non-http(s) schemes, and known OAuth/login hosts (which must
 * never be proxied/fetched server-side on the user's behalf).
 *
 * Used by /api/proxy and /api/briefing/fetch-feeds — any new route that
 * performs a server-side fetch() against a user-supplied URL must call
 * isBlockedUrl() before issuing the request.
 */

const OAUTH_HOSTS = [
  "accounts.google.com",
  "login.microsoftonline.com",
  "login.live.com",
  "accounts.spotify.com",
  "appleid.apple.com",
  "www.strava.com", // strava OAuth lives at /oauth on the main host
  "github.com",
];

function isOAuthHost(host: string): boolean {
  return OAUTH_HOSTS.some((d) => host === d || host.endsWith(`.${d}`));
}

export function isBlockedUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return true;
    const h = u.hostname.toLowerCase();
    const bare = h.replace(/\[|\]/g, "");
    if (h === "localhost" || bare === "127.0.0.1" || bare === "::1" || bare === "0.0.0.0") return true;
    if (/^10\./.test(h)) return true;
    if (/^192\.168\./.test(h)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
    if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".localhost")) return true;
    if (h === "metadata.google.internal" || h === "169.254.169.254") return true;
    if (isOAuthHost(h)) return true;
    return false;
  } catch {
    return true;
  }
}
