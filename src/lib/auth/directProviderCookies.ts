export type DirectProvider = "spotify" | "strava";

const OAUTH_PENDING_STATE_COOKIE: Record<DirectProvider, string> = {
  spotify: "spotify_oauth_state",
  strava: "strava_oauth_state",
};

export function oauthPendingStateCookieName(provider: DirectProvider): string {
  return OAUTH_PENDING_STATE_COOKIE[provider];
}
