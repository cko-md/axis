/** Maps a Spotify OAuth callback failure to something a person can act on. */
export function describeSpotifyConnectFailure(reason?: string): string {
  switch (reason) {
    case "denied":
      return "Spotify authorization was declined.";
    case "not_configured":
      return "Spotify is not configured on the server. SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET must be set.";
    case "state_missing":
    case "state_mismatch":
      return "The Spotify sign-in could not be verified. Try connecting again in a single window.";
    case "token_exchange_failed":
      return "Spotify rejected the sign-in. The redirect URI registered in the Spotify dashboard may not match this site.";
    case "missing_code":
      return "Spotify did not return an authorization code.";
    case "session_expired":
      return "Your AXIS session expired before Spotify finished connecting. Sign in and try again.";
    case "auth_unavailable":
      return "AXIS authentication is temporarily unavailable. Try connecting Spotify again shortly.";
    case "assurance_unavailable":
      return "AXIS could not verify your sign-in security level. Sign in again, then reconnect Spotify.";
    case "mfa_required":
      return "Complete two-factor authentication in AXIS, then reconnect Spotify.";
    default:
      return "Spotify could not be connected.";
  }
}
