import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAppOrigin, buildAppUrl } from "@/lib/auth/getAppOrigin";
import { optionalEnv } from "@/lib/env";
import { captureRouteError } from "@/lib/observability/captureRouteError";

// Every failure below previously collapsed into a bare `status=error`, which
// made a user-denied consent, a dropped state cookie, a misconfigured client,
// and a rejected token exchange indistinguishable from each other — both in the
// UI and in logs. Each branch now carries a distinct reason and is reported.
function fail(req: NextRequest, reason: string, error: Error, status: number) {
  captureRouteError(error, {
    route: "/api/spotify/callback",
    operation: "complete_oauth",
    area: "integrations",
    status,
    code: `SPOTIFY_${reason.toUpperCase()}`,
  });
  return NextResponse.redirect(
    buildAppUrl(req, `/oauth-done?provider=spotify&status=error&reason=${reason}`),
  );
}

export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const providerError = url.searchParams.get("error");
  const cookieStore = await cookies();
  const saved = cookieStore.get("spotify_oauth_state")?.value;

  // Spotify reports a declined consent screen as ?error=access_denied. This was
  // never read, so cancelling looked identical to a broken integration.
  if (providerError) {
    return fail(req, "denied", new Error(`Spotify returned ${providerError}`), 400);
  }
  if (!code) {
    return fail(req, "missing_code", new Error("Spotify callback had no code"), 400);
  }
  if (!saved) {
    return fail(req, "state_missing", new Error("Spotify OAuth state cookie was absent"), 400);
  }
  if (!state || state !== saved) {
    return fail(req, "state_mismatch", new Error("Spotify OAuth state did not match"), 400);
  }

  const clientId = optionalEnv("SPOTIFY_CLIENT_ID");
  const clientSecret = optionalEnv("SPOTIFY_CLIENT_SECRET");
  const redirectUri = `${getAppOrigin(req)}/api/spotify/callback`;

  if (!clientId || !clientSecret) {
    return fail(req, "not_configured", new Error("Spotify credentials are not configured"), 500);
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
    // The token endpoint names the actual problem (invalid_grant,
    // invalid_client, redirect_uri_mismatch). Discarding it is what made a
    // redirect-URI mismatch undiagnosable. The body carries no secret — the
    // credentials travel in the request's Authorization header, not the reply.
    const detail = await tokenRes.text().catch(() => "");
    return fail(
      req,
      "token_exchange_failed",
      new Error(`Spotify token exchange failed (${tokenRes.status}): ${detail.slice(0, 300)}`),
      502,
    );
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
