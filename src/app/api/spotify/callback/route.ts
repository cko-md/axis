import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAppOrigin, buildAppUrl } from "@/lib/auth/getAppOrigin";
import { optionalEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(buildAppUrl(req, "/oauth-done?provider=spotify&status=error"));
  const url = req.nextUrl;
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieStore = await cookies();
  const saved = cookieStore.get("spotify_oauth_state")?.value;

  if (!code || !state || state !== saved) {
    return NextResponse.redirect(buildAppUrl(req, "/oauth-done?provider=spotify&status=error"));
  }

  const clientId = optionalEnv("SPOTIFY_CLIENT_ID");
  const clientSecret = optionalEnv("SPOTIFY_CLIENT_SECRET");
  const redirectUri = `${getAppOrigin(req)}/api/spotify/callback`;

  if (!clientId || !clientSecret) {
    return NextResponse.redirect(buildAppUrl(req, "/oauth-done?provider=spotify&status=error"));
  }

  const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
  });

  if (!tokenRes.ok) {
    return NextResponse.redirect(buildAppUrl(req, "/oauth-done?provider=spotify&status=error"));
  }

  const tokens = await tokenRes.json();
  const secure = process.env.NODE_ENV === "production";
  cookieStore.set("spotify_access_token", tokens.access_token, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    maxAge: tokens.expires_in ?? 3600,
    path: "/",
  });
  cookieStore.set("spotify_token_owner", user.id, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 30,
    path: "/",
  });
  if (tokens.refresh_token) {
    cookieStore.set("spotify_refresh_token", tokens.refresh_token, {
      httpOnly: true,
      secure,
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 30,
      path: "/",
    });
  }
  cookieStore.delete("spotify_oauth_state");

  return NextResponse.redirect(buildAppUrl(req, "/oauth-done?provider=spotify&status=ok"));
}
