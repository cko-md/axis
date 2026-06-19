import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAppOrigin } from "@/lib/auth/getAppOrigin";

export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieStore = await cookies();
  const saved = cookieStore.get("spotify_oauth_state")?.value;

  if (!code || !state || state !== saved) {
    return NextResponse.redirect(new URL("/oauth-done?provider=spotify&status=error", req.url));
  }

  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  const redirectUri = `${getAppOrigin(req)}/api/spotify/callback`;

  if (!clientId || !clientSecret) {
    return NextResponse.redirect(new URL("/oauth-done?provider=spotify&status=error", req.url));
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
    return NextResponse.redirect(new URL("/oauth-done?provider=spotify&status=error", req.url));
  }

  const tokens = await tokenRes.json();
  cookieStore.set("spotify_access_token", tokens.access_token, { httpOnly: true, maxAge: tokens.expires_in ?? 3600, path: "/" });
  if (tokens.refresh_token) {
    cookieStore.set("spotify_refresh_token", tokens.refresh_token, { httpOnly: true, maxAge: 60 * 60 * 24 * 30, path: "/" });
  }
  cookieStore.delete("spotify_oauth_state");

  return NextResponse.redirect(new URL("/oauth-done?provider=spotify&status=ok", req.url));
}
