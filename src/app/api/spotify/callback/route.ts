import { cookies } from "next/headers";
import { NextRequest } from "next/server";
import { getAppOrigin, buildAppUrl } from "@/lib/auth/getAppOrigin";
import { profileSubjectForUserId } from "@/lib/auth/profileSubject.server";
import { directProviderExchangeJson } from "@/lib/auth/directProviderFetch.server";
import { verifiedOAuthPendingStateIssuedAt } from "@/lib/auth/oauthState.server";
import {
  consumeOAuthPendingStateCookie,
  consumeOAuthPendingStateCookieForAttempt,
  peekOAuthPendingStateCookie,
  peekOAuthPendingStateCookieForAttempt,
  replaceProviderTokenCookiesForAttempt,
} from "@/lib/auth/providerCookies.server";
import { privateRedirect } from "@/lib/auth/privateNoStore";
import { optionalEnv } from "@/lib/env";
import { captureRouteError } from "@/lib/observability/captureRouteError";
import { createClient } from "@/lib/supabase/server";

type SpotifyFailureReason =
  | "denied"
  | "missing_code"
  | "state_invalid"
  | "not_configured"
  | "token_exchange_failed"
  | "invalid_token_response"
  | "session_expired";

const SPOTIFY_FAILURE_CODES: Record<SpotifyFailureReason, string> = {
  denied: "SPOTIFY_DENIED",
  missing_code: "SPOTIFY_MISSING_CODE",
  state_invalid: "SPOTIFY_STATE_MISMATCH",
  not_configured: "SPOTIFY_NOT_CONFIGURED",
  token_exchange_failed: "SPOTIFY_TOKEN_EXCHANGE_FAILED",
  invalid_token_response: "SPOTIFY_TOKEN_EXCHANGE_FAILED",
  session_expired: "SPOTIFY_STATE_MISSING",
};

function feedback(req: NextRequest, status: "ok" | "error", reason?: SpotifyFailureReason) {
  const params = new URLSearchParams({ provider: "spotify", status });
  if (reason) params.set("reason", reason);
  return privateRedirect(buildAppUrl(req, `/oauth-done?${params}`));
}

function captureUnexpected(reason: SpotifyFailureReason, status: number) {
  if (status < 500) return;
  captureRouteError(new Error("Spotify OAuth callback failed"), {
    route: "/api/spotify/callback",
    operation: "complete_oauth",
    area: "integrations",
    provider: "spotify",
    status,
    code: SPOTIFY_FAILURE_CODES[reason],
  });
}

function fail(req: NextRequest, reason: SpotifyFailureReason, status: number) {
  captureUnexpected(reason, status);
  return feedback(req, "error", reason);
}

export async function GET(req: NextRequest) {
  const cookieStore = await cookies();
  const legacySealedState = peekOAuthPendingStateCookie(cookieStore, "spotify");
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) {
    if (legacySealedState !== null) {
      consumeOAuthPendingStateCookie(cookieStore, "spotify");
    }
    return fail(req, "session_expired", 401);
  }

  const clientId = optionalEnv("SPOTIFY_CLIENT_ID");
  const clientSecret = optionalEnv("SPOTIFY_CLIENT_SECRET");
  if (!clientId || !clientSecret) return fail(req, "not_configured", 503);

  const providerState = req.nextUrl.searchParams.get("state");
  const subject = profileSubjectForUserId(user.id);
  const attemptSealedState = peekOAuthPendingStateCookieForAttempt(
    cookieStore,
    "spotify",
    providerState,
  );
  const sealedState = attemptSealedState ?? legacySealedState;
  const attemptInitiatedAtMs = verifiedOAuthPendingStateIssuedAt({
    provider: "spotify",
    subject,
    secret: clientSecret,
    providerState,
    sealedState,
  });
  if (attemptInitiatedAtMs === null || providerState === null) {
    return fail(req, "state_invalid", 400);
  }
  if (attemptSealedState !== null) {
    consumeOAuthPendingStateCookieForAttempt(
      cookieStore,
      "spotify",
      providerState,
    );
  } else {
    consumeOAuthPendingStateCookie(cookieStore, "spotify");
  }

  if (req.nextUrl.searchParams.has("error")) {
    return fail(req, "denied", 400);
  }
  const code = req.nextUrl.searchParams.get("code");
  if (!code) return fail(req, "missing_code", 400);

  const redirectUri = `${getAppOrigin(req)}/api/spotify/callback`;
  let exchange: { response: Response; body: {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
  } | null };
  try {
    exchange = await directProviderExchangeJson(
      "https://accounts.spotify.com/api/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
        }),
      },
    );
  } catch (error) {
    const status = error instanceof DOMException && error.name === "AbortError"
      ? 504
      : 502;
    return fail(req, "token_exchange_failed", status);
  }
  const { response: tokenRes, body: tokens } = exchange;
  if (!tokenRes.ok) return fail(req, "token_exchange_failed", 502);
  if (typeof tokens?.access_token !== "string" || !tokens.access_token) {
    return fail(req, "invalid_token_response", 502);
  }
  replaceProviderTokenCookiesForAttempt(cookieStore, "spotify", {
    accessToken: tokens.access_token,
    refreshToken: typeof tokens.refresh_token === "string"
      ? tokens.refresh_token
      : undefined,
    expiresIn: tokens.expires_in,
  }, subject, clientSecret, {
    providerState,
    initiatedAtMs: attemptInitiatedAtMs,
  });

  return feedback(req, "ok");
}
