import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  isConfigured,
  getAccessToken,
  stravaGet,
  notConnected,
  type StravaActivity,
  type StravaStats,
  type StravaAthlete,
} from "./_lib";

export const runtime = "nodejs";

/**
 * Unified Strava API route.
 * GET /api/strava?action=status      — connection status
 * GET /api/strava?action=auth        — redirect to Strava OAuth
 * GET /api/strava?action=callback    — exchange code for tokens (Strava calls back here)
 * GET /api/strava?action=activities  — recent activities (up to 20)
 * GET /api/strava?action=stats       — athlete lifetime stats
 * GET /api/strava?action=disconnect  — clear cookies / disconnect
 */
export async function GET(req: NextRequest) {
  const action = req.nextUrl.searchParams.get("action") ?? "status";

  // ── AUTH REDIRECT ──────────────────────────────────────────────────────────
  if (action === "auth") {
    const clientId = process.env.STRAVA_CLIENT_ID;
    if (!clientId) {
      return NextResponse.json({ error: "STRAVA_CLIENT_ID not configured" }, { status: 503 });
    }

    const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"}/api/strava?action=callback`;
    const state = crypto.randomUUID();
    const cookieStore = await cookies();
    cookieStore.set("strava_oauth_state", state, { httpOnly: true, maxAge: 600, path: "/" });

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      approval_prompt: "auto",
      scope: "read,activity:read_all,profile:read_all",
      state,
    });

    return NextResponse.redirect(`https://www.strava.com/oauth/authorize?${params}`);
  }

  // ── OAUTH CALLBACK ─────────────────────────────────────────────────────────
  if (action === "callback") {
    const code = req.nextUrl.searchParams.get("code");
    const state = req.nextUrl.searchParams.get("state");
    const cookieStore = await cookies();
    const savedState = cookieStore.get("strava_oauth_state")?.value;

    if (!code || !state || state !== savedState) {
      return NextResponse.redirect(new URL("/oauth-done?provider=strava&status=error", req.url));
    }

    const clientId = process.env.STRAVA_CLIENT_ID;
    const clientSecret = process.env.STRAVA_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      return NextResponse.redirect(new URL("/oauth-done?provider=strava&status=error", req.url));
    }

    const tokenRes = await fetch("https://www.strava.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenRes.ok) {
      return NextResponse.redirect(new URL("/oauth-done?provider=strava&status=error", req.url));
    }

    const tokens = await tokenRes.json();
    cookieStore.set("strava_access_token", tokens.access_token, {
      httpOnly: true,
      maxAge: tokens.expires_in ?? 21600,
      path: "/",
      sameSite: "lax",
    });
    if (tokens.refresh_token) {
      cookieStore.set("strava_refresh_token", tokens.refresh_token, {
        httpOnly: true,
        maxAge: 60 * 60 * 24 * 90,
        path: "/",
        sameSite: "lax",
      });
    }
    cookieStore.delete("strava_oauth_state");

    return NextResponse.redirect(new URL("/oauth-done?provider=strava&status=ok", req.url));
  }

  // ── DISCONNECT ─────────────────────────────────────────────────────────────
  if (action === "disconnect") {
    const cookieStore = await cookies();
    cookieStore.delete("strava_access_token");
    cookieStore.delete("strava_refresh_token");
    return NextResponse.json({ connected: false });
  }

  // ── STATUS ─────────────────────────────────────────────────────────────────
  if (action === "status") {
    const token = await getAccessToken();
    if (!token) return notConnected();
    const athlete = await stravaGet<StravaAthlete>(token, "/athlete");
    return NextResponse.json({
      connected: Boolean(athlete),
      configured: isConfigured(),
      athlete: athlete ? { name: `${athlete.firstname} ${athlete.lastname}`, avatar: athlete.profile } : null,
    });
  }

  // ── ACTIVITIES ─────────────────────────────────────────────────────────────
  if (action === "activities") {
    const token = await getAccessToken();
    if (!token) return notConnected();

    // Fetch up to 20 most recent activities
    const activities = await stravaGet<StravaActivity[]>(
      token,
      "/athlete/activities?per_page=20&page=1",
    );
    if (!activities) {
      return NextResponse.json({ connected: true, activities: [], error: "fetch_failed" });
    }
    return NextResponse.json({ connected: true, activities });
  }

  // ── STATS ──────────────────────────────────────────────────────────────────
  if (action === "stats") {
    const token = await getAccessToken();
    if (!token) return notConnected();

    // We need the athlete id first
    const athlete = await stravaGet<StravaAthlete>(token, "/athlete");
    if (!athlete) {
      return NextResponse.json({ connected: true, stats: null, error: "athlete_fetch_failed" });
    }
    const stats = await stravaGet<StravaStats>(token, `/athletes/${athlete.id}/stats`);
    return NextResponse.json({ connected: true, stats });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
