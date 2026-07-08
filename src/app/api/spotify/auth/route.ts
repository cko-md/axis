import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { getAppOrigin } from "@/lib/auth/getAppOrigin";
import { optionalEnv, hasOptionalEnv } from "@/lib/env";

const SCOPES = [
  // Web Playback SDK (the in-browser "Axis Web Player" device) requires these
  // three — without `streaming` the SDK token is rejected and no device ever
  // becomes ready, so play/pause silently no-ops with "no active device".
  // (Spotify also requires a Premium account for SDK playback.)
  "streaming",
  "user-read-email",
  "user-read-private",
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
  "user-read-recently-played",
  "user-top-read",
  "user-library-read",
  "playlist-read-private",
  "playlist-read-collaborative",
  "playlist-modify-private",
  "playlist-modify-public",
].join(" ");

export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  const clientId = optionalEnv("SPOTIFY_CLIENT_ID");
  if (!clientId && !hasOptionalEnv("COMPOSIO_API_KEY")) {
    return NextResponse.redirect(new URL("/oauth-done?provider=spotify&status=error", req.url));
  }
  if (!clientId) {
    return NextResponse.redirect(new URL("/api/integrations/composio/connect?toolkit=spotify", req.url));
  }
  const redirectUri = `${getAppOrigin(req)}/api/spotify/callback`;
  const state = crypto.randomUUID();
  const cookieStore = await cookies();
  cookieStore.set("spotify_oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 600,
    path: "/",
  });

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: SCOPES,
    state,
  });

  return NextResponse.redirect(`https://accounts.spotify.com/authorize?${params}`);
}
