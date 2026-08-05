import { isIP } from "node:net";

import { isBlockedAddress } from "./safe-fetch";

const OAUTH_HOSTS = [
  "accounts.google.com",
  "login.microsoftonline.com",
  "login.live.com",
  "accounts.spotify.com",
  "appleid.apple.com",
  "www.strava.com",
  "github.com",
];

function isOAuthHost(host: string): boolean {
  return OAUTH_HOSTS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/**
 * @deprecated Compatibility preflight only. It must never authorize an
 * outbound request: safeFetch resolves, validates, and pins every network hop.
 */
export function isBlockedUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return true;
    const host = url.hostname.toLowerCase();
    const bareHost = host.replace(/^\[|\]$/g, "");
    if (isIP(bareHost)) return isBlockedAddress(bareHost);
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
    if (host === "metadata.google.internal") return true;
    return isOAuthHost(host);
  } catch {
    return true;
  }
}
