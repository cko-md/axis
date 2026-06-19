import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAppOrigin } from "@/lib/auth/getAppOrigin";

const SCOPES = [
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
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json({ error: "SPOTIFY_CLIENT_ID not configured" }, { status: 503 });
  }
  const redirectUri = `${getAppOrigin(req)}/api/spotify/callback`;
  const state = crypto.randomUUID();
  const cookieStore = await cookies();
  cookieStore.set("spotify_oauth_state", state, { httpOnly: true, maxAge: 600, path: "/" });

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: SCOPES,
    state,
  });

  return NextResponse.redirect(`https://accounts.spotify.com/authorize?${params}`);
}
