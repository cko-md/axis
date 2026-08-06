import { describe, expect, it } from "vitest";
import { describeSpotifyConnectFailure } from "./connectFailure";

describe("Spotify authentication feedback", () => {
  it.each([
    ["session_expired", "Your AXIS session expired before Spotify finished connecting. Sign in and try again."],
    ["auth_unavailable", "AXIS authentication is temporarily unavailable. Try connecting Spotify again shortly."],
    ["assurance_unavailable", "AXIS could not verify your sign-in security level. Sign in again, then reconnect Spotify."],
    ["mfa_required", "Complete two-factor authentication in AXIS, then reconnect Spotify."],
  ])("maps %s to actionable feedback", (reason, message) => {
    expect(describeSpotifyConnectFailure(reason)).toBe(message);
  });
});
