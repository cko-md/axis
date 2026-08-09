import { cookies } from "next/headers";
import {
  clearProviderCredentialCookiesForSubject,
  providerTokensForSubject,
  replaceRefreshedProviderTokenCookies,
} from "@/lib/auth/providerCookies.server";
import {
  DirectProviderRefreshError,
  providerRefreshTransportError,
} from "@/lib/auth/directProviderRefresh.server";
import { privateJson } from "@/lib/auth/privateNoStore";
import { profileSubjectForUserId } from "@/lib/auth/profileSubject.server";
import { directProviderExchangeJson } from "@/lib/auth/directProviderFetch.server";
import { hasOptionalEnv, optionalEnv } from "@/lib/env";

/**
 * Shared Spotify server helpers. Tokens live in httpOnly cookies and are
 * NEVER exposed to the client. The client secret is read from server env only.
 *
 * Connection state degrades cleanly: when env is unset or no tokens exist,
 * getAccessToken() returns null and callers respond with { connected:false }.
 */

const TOKEN_URL = "https://accounts.spotify.com/api/token";
export const API = "https://api.spotify.com/v1";

export function isConfigured(): boolean {
  return hasOptionalEnv("SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET");
}

/** Returns a token only when the cookies belong to the authenticated Axis user. */
export async function getAccessToken(userId: string): Promise<string | null> {
  const subject = profileSubjectForUserId(userId);
  const clientSecret = optionalEnv("SPOTIFY_CLIENT_SECRET") ?? "";
  const cookieStore = await cookies();
  const tokens = providerTokensForSubject(cookieStore, "spotify", subject, clientSecret);
  if (tokens.accessToken) return tokens.accessToken;

  const clientId = optionalEnv("SPOTIFY_CLIENT_ID");
  if (!tokens.refreshToken || !clientId || !clientSecret) return null;

  let exchange: { response: Response; body: {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    error?: unknown;
  } | null };
  try {
    exchange = await directProviderExchangeJson(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refreshToken,
      }),
    });
  } catch (error) {
    throw providerRefreshTransportError("spotify", error);
  }
  const { response: res, body: data } = exchange;
  if (!res.ok) {
    if (
      res.status >= 400 &&
      res.status < 500 &&
      data?.error === "invalid_grant"
    ) {
      clearProviderCredentialCookiesForSubject(
        cookieStore,
        "spotify",
        subject,
        clientSecret,
      );
      return null;
    }
    if (res.status >= 400) {
      throw new DirectProviderRefreshError({
        provider: "spotify",
        status: 502,
        code: "PROVIDER_REFRESH_UNAVAILABLE",
      });
    }
  }
  const fresh = typeof data?.access_token === "string" ? data.access_token : null;
  if (!fresh) {
    throw new DirectProviderRefreshError({
      provider: "spotify",
      status: 502,
      code: "PROVIDER_REFRESH_INVALID_RESPONSE",
    });
  }
  replaceRefreshedProviderTokenCookies(cookieStore, "spotify", {
    accessToken: fresh,
    refreshToken: typeof data?.refresh_token === "string" && data.refresh_token
      ? data.refresh_token
      : tokens.refreshToken,
    expiresIn: data?.expires_in,
  }, subject, clientSecret, tokens.credentialAttempt);
  return fresh;
}

/** Standard "not connected" payload — drives the setup-state in the UI. */
export function notConnected() {
  return privateJson({ connected: false, configured: isConfigured() });
}

/** Authenticated fetch against the Spotify Web API. Returns the raw Response. */
export async function spotifyFetch(
  token: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
    cache: "no-store",
  });
}

/** GET an API path and parse JSON, tolerating 204/empty bodies. Returns null on error. */
export async function spotifyGet<T>(token: string, path: string): Promise<T | null> {
  const res = await spotifyFetch(token, path);
  if (res.status === 204 || res.status === 205) return null;
  if (!res.ok) return null;
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

// ── Shared shapes the UI consumes ─────────────────────────────────────────

export type ImageRef = { url: string; width?: number | null; height?: number | null };

export function pickArt(images?: ImageRef[] | null): string | null {
  if (!images || images.length === 0) return null;
  return images[0]?.url ?? null;
}

export type TrackLite = {
  id: string;
  uri: string;
  name: string;
  artists: string;
  album: string;
  art: string | null;
  durationMs: number;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
export function toTrackLite(t: any): TrackLite {
  return {
    id: t?.id ?? "",
    uri: t?.uri ?? "",
    name: t?.name ?? "Unknown",
    artists: (t?.artists ?? []).map((a: any) => a?.name).filter(Boolean).join(", "),
    album: t?.album?.name ?? "",
    art: pickArt(t?.album?.images),
    durationMs: t?.duration_ms ?? 0,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
