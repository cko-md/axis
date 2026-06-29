import { optionalEnv } from "@/lib/env";

/**
 * Shared OAuth token-refresh helpers.
 *
 * Calendar, Mail, and Contacts each store their own provider tokens but all
 * refresh Google / Microsoft access tokens the same way. These helpers
 * centralize that fetch so the per-feature `tokens.ts` files only need to
 * wire up their own storage (table name, column mapping).
 */

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const MICROSOFT_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const DEFAULT_EXPIRES_IN_SECONDS = 3600;

export interface RefreshedToken {
  accessToken: string;
  expiresIn: number;
}

/** Refreshes a Google OAuth access token using a stored refresh token. */
export async function refreshGoogleOAuth(refreshToken: string): Promise<RefreshedToken | null> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: optionalEnv("GOOGLE_CLIENT_ID") ?? "",
      client_secret: optionalEnv("GOOGLE_CLIENT_SECRET") ?? "",
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) return null;
  const json = await res.json();
  return { accessToken: json.access_token as string, expiresIn: (json.expires_in as number) ?? DEFAULT_EXPIRES_IN_SECONDS };
}

/** Refreshes a Microsoft OAuth access token using a stored refresh token. */
export async function refreshMicrosoftOAuth(refreshToken: string, scope: string): Promise<RefreshedToken | null> {
  const res = await fetch(MICROSOFT_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: optionalEnv("MICROSOFT_CLIENT_ID") ?? "",
      client_secret: optionalEnv("MICROSOFT_CLIENT_SECRET") ?? "",
      refresh_token: refreshToken,
      grant_type: "refresh_token",
      scope,
    }),
  });
  if (!res.ok) return null;
  const json = await res.json();
  return { accessToken: json.access_token as string, expiresIn: (json.expires_in as number) ?? DEFAULT_EXPIRES_IN_SECONDS };
}
