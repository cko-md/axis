import type { DirectOAuthProvider } from "@/lib/auth/oauthState.server";

/** Maps direct OAuth failures to provider-specific, actionable UI feedback. */
export function describeDirectProviderConnectFailure(
  provider: DirectOAuthProvider,
  reason?: string,
): string {
  const name = provider === "spotify" ? "Spotify" : "Strava";
  switch (reason) {
    case "denied":
      return `${name} authorization was declined.`;
    case "not_configured":
      return `${name} is not configured on the server.`;
    case "state_invalid":
    case "state_missing":
    case "state_mismatch":
      return `The ${name} sign-in could not be verified. Try connecting again in a single window.`;
    case "token_exchange_failed":
    case "invalid_token_response":
      return `${name} rejected the sign-in. Verify the provider redirect URI and try again.`;
    case "missing_code":
      return `${name} did not return an authorization code.`;
    case "session_expired":
      return `Your AXIS session expired before ${name} finished connecting. Sign in and try again.`;
    case "popup_blocked":
      return `Allow pop-ups for AXIS, then reconnect ${name}.`;
    case "invalid_authorization_url":
      return `${name} returned an invalid authorization destination.`;
    case "cancelled":
      return `${name} authorization was cancelled.`;
    default:
      return `${name} could not be connected.`;
  }
}
