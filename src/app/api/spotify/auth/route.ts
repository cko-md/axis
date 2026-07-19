import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { getAppOrigin, buildAppUrl } from "@/lib/auth/getAppOrigin";
import { optionalEnv } from "@/lib/env";
import { captureRouteError } from "@/lib/observability/captureRouteError";

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
  if (!clientId) {
    // Spotify is a DIRECT OAuth integration. There was previously a fallback
    // here that redirected to the Composio connector when SPOTIFY_CLIENT_ID was
    // absent, but nothing reads that result: getAccessToken() in _lib.ts only
    // ever looks at the spotify_access_token / spotify_refresh_token cookies and
    // has no Composio awareness. A Composio grant therefore always left the app
    // reporting "not connected". Failing honestly is the truthful outcome.
    captureRouteError(new Error("Spotify client id is not configured"), {
      route: "/api/spotify/auth",
      operation: "start_oauth",
      area: "integrations",
      status: 500,
      code: "SPOTIFY_NOT_CONFIGURED",
    });
    return NextResponse.redirect(
      buildAppUrl(req, "/oauth-done?provider=spotify&status=error&reason=not_configured"),
    );
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
