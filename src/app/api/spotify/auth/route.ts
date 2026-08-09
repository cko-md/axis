import { cookies } from "next/headers";
import { NextRequest } from "next/server";
import { validateExpectedProfileSubject } from "@/lib/auth/expectedProfileSubject.server";
import {
  createOAuthPendingState,
  OAUTH_STATE_TTL_SECONDS,
} from "@/lib/auth/oauthState.server";
import {
  nextProviderAuthorizationIssuedAt,
  setOAuthPendingStateCookie,
} from "@/lib/auth/providerCookies.server";
import { privateJson } from "@/lib/auth/privateNoStore";
import { getAppOrigin } from "@/lib/auth/getAppOrigin";
import { optionalEnv } from "@/lib/env";
import { captureRouteError } from "@/lib/observability/captureRouteError";
import { createClient } from "@/lib/supabase/server";

const SCOPES = [
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

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) {
    return privateJson({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  const identity = validateExpectedProfileSubject(req, user.id);
  if (!identity.ok) return identity.response;

  const clientId = optionalEnv("SPOTIFY_CLIENT_ID");
  const clientSecret = optionalEnv("SPOTIFY_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    captureRouteError(new Error("Spotify OAuth is not configured"), {
      route: "/api/spotify/auth",
      operation: "start_oauth",
      area: "integrations",
      provider: "spotify",
      status: 503,
      code: "SPOTIFY_NOT_CONFIGURED",
    });
    return privateJson({ error: "SPOTIFY_NOT_CONFIGURED" }, { status: 503 });
  }

  const redirectUri = `${getAppOrigin(req)}/api/spotify/callback`;
  const cookieStore = await cookies();
  const { providerState, sealedState } = createOAuthPendingState({
    provider: "spotify",
    subject: identity.subject,
    secret: clientSecret,
    nowMs: nextProviderAuthorizationIssuedAt(
      cookieStore,
      "spotify",
      identity.subject,
      clientSecret,
    ),
  });
  setOAuthPendingStateCookie(
    cookieStore,
    "spotify",
    sealedState,
    OAUTH_STATE_TTL_SECONDS,
    providerState,
  );

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: SCOPES,
    state: providerState,
  });
  return privateJson({ url: `https://accounts.spotify.com/authorize?${params}` });
}

export function GET() {
  return privateJson(
    { error: "METHOD_NOT_ALLOWED" },
    { status: 405, headers: { Allow: "POST" } },
  );
}
