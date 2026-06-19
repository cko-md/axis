import { cookies } from "next/headers";
import { NextResponse } from "next/server";

/**
 * Shared Strava server helpers. Tokens live in httpOnly cookies and are
 * NEVER exposed to the client. The client secret is read from server env only.
 *
 * Connection state degrades cleanly: when env is unset or no tokens exist,
 * getAccessToken() returns null and callers respond with { connected: false }.
 */

const TOKEN_URL = "https://www.strava.com/oauth/token";
export const STRAVA_API = "https://www.strava.com/api/v3";

export function isConfigured(): boolean {
  return Boolean(process.env.STRAVA_CLIENT_ID && process.env.STRAVA_CLIENT_SECRET);
}

/** Returns a valid access token, refreshing via the stored refresh token when needed, or null. */
export async function getAccessToken(): Promise<string | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get("strava_access_token")?.value;
  if (token) return token;

  const refresh = cookieStore.get("strava_refresh_token")?.value;
  const clientId = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;
  if (!refresh || !clientId || !clientSecret) return null;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refresh,
      grant_type: "refresh_token",
    }),
    cache: "no-store",
  });
  if (!res.ok) return null;
  const data = await res.json();
  const fresh = data.access_token as string | undefined;
  if (!fresh) return null;
  cookieStore.set("strava_access_token", fresh, {
    httpOnly: true,
    maxAge: data.expires_in ?? 21600,
    path: "/",
    sameSite: "lax",
  });
  if (data.refresh_token) {
    cookieStore.set("strava_refresh_token", data.refresh_token, {
      httpOnly: true,
      maxAge: 60 * 60 * 24 * 90,
      path: "/",
      sameSite: "lax",
    });
  }
  return fresh;
}

/** Standard "not connected" payload — drives the setup-state in the UI. */
export function notConnected() {
  return NextResponse.json({ connected: false, configured: isConfigured() });
}

/** Authenticated fetch against the Strava API. Returns the raw Response. */
export async function stravaFetch(
  token: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(`${STRAVA_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });
}

/** GET an API path and parse JSON, tolerating empty bodies. Returns null on error. */
export async function stravaGet<T>(token: string, path: string): Promise<T | null> {
  const res = await stravaFetch(token, path);
  if (!res.ok) return null;
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

// ─── Strava API types ───────────────────────────────────────────────────────

export type StravaActivity = {
  id: number;
  name: string;
  type: string;
  sport_type: string;
  start_date: string;
  distance: number;         // metres
  moving_time: number;      // seconds
  elapsed_time: number;     // seconds
  total_elevation_gain: number;
  average_speed: number;    // m/s
  max_speed: number;        // m/s
  average_heartrate?: number;
  max_heartrate?: number;
  suffer_score?: number;
  map?: { summary_polyline?: string };
};

export type StravaStats = {
  recent_run_totals: { count: number; distance: number; moving_time: number; elevation_gain: number };
  all_run_totals:    { count: number; distance: number; moving_time: number; elevation_gain: number };
  ytd_run_totals:    { count: number; distance: number; moving_time: number; elevation_gain: number };
};

export type StravaAthlete = {
  id: number;
  firstname: string;
  lastname: string;
  profile: string;
};

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Convert metres to km, rounded to 1dp. */
export function metresToKm(m: number): number {
  return Math.round((m / 1000) * 10) / 10;
}

/** Convert m/s to min/km pace string like "5:12". */
export function speedToPace(mps: number): string {
  if (!mps || mps <= 0) return "—";
  const secPerKm = 1000 / mps;
  const mins = Math.floor(secPerKm / 60);
  const secs = Math.round(secPerKm % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

/** Convert seconds to "h:mm" or "mm:ss". */
export function secsToHMS(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}h`;
  return `${m}m`;
}

/** ISO date → "Mon 2 Jun" label. */
export function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

/**
 * Build a Strava activity context string for the AI training plan generator.
 * Summarises the last 4 weeks of runs.
 */
export function buildStravaContext(activities: StravaActivity[]): string {
  const now = Date.now();
  const fourWeeksMs = 28 * 24 * 60 * 60 * 1000;
  const recent = activities.filter(
    (a) =>
      (a.sport_type === "Run" || a.type === "Run") &&
      now - new Date(a.start_date).getTime() < fourWeeksMs,
  );
  if (!recent.length) return "";

  // Weekly buckets (0 = this week, 1 = last week, …)
  const weeks: Record<number, { distance: number; count: number; longRun: number }> = {};
  for (const a of recent) {
    const daysAgo = Math.floor((now - new Date(a.start_date).getTime()) / (86400 * 1000));
    const weekIdx = Math.floor(daysAgo / 7);
    if (!weeks[weekIdx]) weeks[weekIdx] = { distance: 0, count: 0, longRun: 0 };
    weeks[weekIdx].distance += a.distance;
    weeks[weekIdx].count += 1;
    if (a.distance > weeks[weekIdx].longRun) weeks[weekIdx].longRun = a.distance;
  }

  const avgPace = speedToPace(
    recent.reduce((s, a) => s + a.average_speed, 0) / recent.length,
  );

  const lines = ["Recent Strava running data (last 4 weeks):"];
  for (let w = 3; w >= 0; w--) {
    const wk = weeks[w];
    if (wk) {
      const label = w === 0 ? "This week" : w === 1 ? "Last week" : `${w * 7}d ago week`;
      lines.push(`  ${label}: ${metresToKm(wk.distance)} km across ${wk.count} run(s), longest ${metresToKm(wk.longRun)} km`);
    }
  }
  lines.push(`  Average easy pace: ${avgPace} /km`);
  lines.push(`  Total runs in period: ${recent.length}`);
  return lines.join("\n");
}
