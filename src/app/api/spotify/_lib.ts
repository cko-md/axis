import { cookies } from "next/headers";
import { NextResponse } from "next/server";

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
  return Boolean(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET);
}

/** Returns a valid access token, refreshing via the stored refresh token when needed, or null. */
export async function getAccessToken(): Promise<string | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get("spotify_access_token")?.value;
  if (token) return token;

  const refresh = cookieStore.get("spotify_refresh_token")?.value;
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!refresh || !clientId || !clientSecret) return null;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh }),
    cache: "no-store",
  });
  if (!res.ok) return null;
  const data = await res.json();
  const fresh = data.access_token as string | undefined;
  if (!fresh) return null;
  cookieStore.set("spotify_access_token", fresh, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    maxAge: data.expires_in ?? 3600,
    path: "/",
    sameSite: "lax",
  });
  return fresh;
}

/** Standard "not connected" payload — drives the setup-state in the UI. */
export function notConnected() {
  return NextResponse.json({ connected: false, configured: isConfigured() });
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
