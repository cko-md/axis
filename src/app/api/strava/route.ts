import { cookies } from "next/headers";
import { NextRequest } from "next/server";
import { validateExpectedProfileSubject } from "@/lib/auth/expectedProfileSubject.server";
import { getAppOrigin, buildAppUrl } from "@/lib/auth/getAppOrigin";
import {
  createOAuthPendingState,
  OAUTH_STATE_TTL_SECONDS,
  verifyOAuthPendingState,
} from "@/lib/auth/oauthState.server";
import { profileSubjectForUserId } from "@/lib/auth/profileSubject.server";
import { directProviderExchangeFetch } from "@/lib/auth/directProviderFetch.server";
import {
  clearProviderTokenCookies,
  consumeOAuthPendingStateCookie,
  replaceProviderTokenCookies,
  setOAuthPendingStateCookie,
} from "@/lib/auth/providerCookies.server";
import { privateJson, privateRedirect } from "@/lib/auth/privateNoStore";
import { optionalEnv } from "@/lib/env";
import {
  getComposioStravaConnection,
  getComposioStravaAthlete,
  listComposioStravaActivities,
} from "@/lib/integrations/strava-composio";
import { captureRouteError } from "@/lib/observability/captureRouteError";
import { createClient } from "@/lib/supabase/server";
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

type StravaFailureReason =
  | "denied"
  | "missing_code"
  | "state_invalid"
  | "not_configured"
  | "token_exchange_failed"
  | "invalid_token_response"
  | "session_expired";

function callbackFeedback(
  req: NextRequest,
  status: "ok" | "error",
  reason?: StravaFailureReason,
) {
  const params = new URLSearchParams({ provider: "strava", status });
  if (reason) params.set("reason", reason);
  return privateRedirect(buildAppUrl(req, `/oauth-done?${params}`));
}

function callbackFailure(req: NextRequest, reason: StravaFailureReason, status: number) {
  if (status >= 500) {
    if (reason === "not_configured") {
      captureRouteError(new Error("Strava OAuth callback failed"), {
        route: "/api/strava",
        operation: "complete_oauth",
        area: "integrations",
        provider: "strava",
        status: 503,
        code: "NOT_CONFIGURED",
      });
    } else if (reason === "token_exchange_failed") {
      if (status === 504) {
        captureRouteError(new Error("Strava OAuth callback failed"), {
          route: "/api/strava",
          operation: "complete_oauth",
          area: "integrations",
          provider: "strava",
          status: 504,
          code: "PROVIDER_TIMEOUT",
        });
      } else {
        captureRouteError(new Error("Strava OAuth callback failed"), {
          route: "/api/strava",
          operation: "complete_oauth",
          area: "integrations",
          provider: "strava",
          status: 502,
          code: "PROVIDER_ERROR",
        });
      }
    } else {
      captureRouteError(new Error("Strava OAuth callback failed"), {
        route: "/api/strava",
        operation: "complete_oauth",
        area: "integrations",
        provider: "strava",
        status: 502,
        code: "PROVIDER_ERROR",
      });
    }
  }
  return callbackFeedback(req, "error", reason);
}

async function completeCallback(
  req: NextRequest,
  userId: string,
  sealedState: string | null,
  cookieStore: Awaited<ReturnType<typeof cookies>>,
) {
  const clientId = optionalEnv("STRAVA_CLIENT_ID");
  const clientSecret = optionalEnv("STRAVA_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    return callbackFailure(req, "not_configured", 503);
  }

  const subject = profileSubjectForUserId(userId);
  if (!verifyOAuthPendingState({
    provider: "strava",
    subject,
    secret: clientSecret,
    providerState: req.nextUrl.searchParams.get("state"),
    sealedState,
  })) {
    return callbackFailure(req, "state_invalid", 400);
  }
  if (req.nextUrl.searchParams.has("error")) {
    return callbackFailure(req, "denied", 400);
  }
  const code = req.nextUrl.searchParams.get("code");
  if (!code) return callbackFailure(req, "missing_code", 400);

  let tokenRes: Response;
  try {
    tokenRes = await directProviderExchangeFetch(
      "https://www.strava.com/oauth/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          grant_type: "authorization_code",
        }),
      },
    );
  } catch {
    return callbackFailure(req, "token_exchange_failed", 504);
  }
  if (!tokenRes.ok) return callbackFailure(req, "token_exchange_failed", 502);

  const tokens = await tokenRes.json().catch(() => null) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
  } | null;
  if (typeof tokens?.access_token !== "string" || !tokens.access_token) {
    return callbackFailure(req, "invalid_token_response", 502);
  }
  replaceProviderTokenCookies(cookieStore, "strava", {
    accessToken: tokens.access_token,
    refreshToken: typeof tokens.refresh_token === "string"
      ? tokens.refresh_token
      : undefined,
    expiresIn: tokens.expires_in,
  }, subject, clientSecret);
  return callbackFeedback(req, "ok");
}

async function initiateAuth(req: NextRequest, subject: string) {
  const clientId = optionalEnv("STRAVA_CLIENT_ID");
  const clientSecret = optionalEnv("STRAVA_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    captureRouteError(new Error("Strava OAuth is not configured"), {
      route: "/api/strava",
      operation: "start_oauth",
      area: "integrations",
      provider: "strava",
      status: 503,
      code: "NOT_CONFIGURED",
    });
    return privateJson({ error: "STRAVA_NOT_CONFIGURED" }, { status: 503 });
  }
  const redirectUri = `${getAppOrigin(req)}/api/strava?action=callback`;
  const { providerState, sealedState } = createOAuthPendingState({
    provider: "strava",
    subject,
    secret: clientSecret,
  });
  const cookieStore = await cookies();
  setOAuthPendingStateCookie(
    cookieStore,
    "strava",
    sealedState,
    OAUTH_STATE_TTL_SECONDS,
  );
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    approval_prompt: "auto",
    scope: "read,activity:read_all,profile:read_all",
    state: providerState,
  });
  return privateJson({ url: `https://www.strava.com/oauth/authorize?${params}` });
}

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return privateJson({ error: "UNAUTHORIZED" }, { status: 401 });
  const identity = validateExpectedProfileSubject(req, user.id);
  if (!identity.ok) return identity.response;

  const actions = req.nextUrl.searchParams.getAll("action");
  if (actions.length === 1 && actions[0] === "auth") {
    return initiateAuth(req, identity.subject);
  }
  if (actions.length === 1 && actions[0] === "disconnect") {
    const cookieStore = await cookies();
    clearProviderTokenCookies(cookieStore, "strava");
    return privateJson({ connected: false });
  }
  return privateJson(
    { error: "METHOD_NOT_ALLOWED" },
    { status: 405, headers: { Allow: "GET" } },
  );
}

export async function GET(req: NextRequest) {
  const actions = req.nextUrl.searchParams.getAll("action");
  const action = actions.length === 0 ? "status" : actions[0];
  const exactCallback = actions.length === 1 && action === "callback";
  const callbackCookieStore = exactCallback ? await cookies() : null;
  // Consume before route authentication as defense-in-depth for any invocation
  // path that reaches this handler without the middleware auth boundary.
  const sealedCallbackState = callbackCookieStore
    ? consumeOAuthPendingStateCookie(callbackCookieStore, "strava")
    : null;
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) {
    return exactCallback
      ? callbackFailure(req, "session_expired", 401)
      : privateJson({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  if (exactCallback && callbackCookieStore) {
    return completeCallback(req, user.id, sealedCallbackState, callbackCookieStore);
  }

  const identity = validateExpectedProfileSubject(req, user.id);
  if (!identity.ok) return identity.response;
  if (actions.length > 1) {
    return privateJson({ error: "Unknown action" }, { status: 400 });
  }
  if (action === "auth" || action === "disconnect") {
    return privateJson(
      { error: "METHOD_NOT_ALLOWED" },
      { status: 405, headers: { Allow: "POST" } },
    );
  }

  if (action === "status") {
    const composio = await getComposioStravaConnection(user.id);
    if (composio) {
      const athlete = await getComposioStravaAthlete(
        composio.connectedAccountId,
        user.id,
      );
      return privateJson({
        connected: Boolean(athlete),
        configured: true,
        via: "composio",
        athlete: athlete
          ? { name: `${athlete.firstname} ${athlete.lastname}`, avatar: athlete.profile }
          : null,
      });
    }

    const token = await getAccessToken(user.id);
    if (!token) return notConnected();
    const athlete = await stravaGet<StravaAthlete>(token, "/athlete");
    return privateJson({
      connected: Boolean(athlete),
      configured: isConfigured(),
      via: "direct",
      athlete: athlete
        ? { name: `${athlete.firstname} ${athlete.lastname}`, avatar: athlete.profile }
        : null,
    });
  }

  if (action === "activities") {
    const composio = await getComposioStravaConnection(user.id);
    if (composio) {
      try {
        const activities = await listComposioStravaActivities(
          composio.connectedAccountId,
          user.id,
        );
        return privateJson({ connected: true, via: "composio", activities });
      } catch {
        return privateJson({
          connected: true,
          via: "composio",
          activities: [],
          error: "fetch_failed",
        });
      }
    }

    const token = await getAccessToken(user.id);
    if (!token) return notConnected();
    const activities = await stravaGet<StravaActivity[]>(
      token,
      "/athlete/activities?per_page=20&page=1",
    );
    if (!activities) {
      return privateJson({ connected: true, activities: [], error: "fetch_failed" });
    }
    return privateJson({ connected: true, activities });
  }

  if (action === "stats") {
    const token = await getAccessToken(user.id);
    if (!token) return notConnected();
    const athlete = await stravaGet<StravaAthlete>(token, "/athlete");
    if (!athlete) {
      return privateJson({
        connected: true,
        stats: null,
        error: "athlete_fetch_failed",
      });
    }
    const stats = await stravaGet<StravaStats>(token, `/athletes/${athlete.id}/stats`);
    return privateJson({ connected: true, stats });
  }

  return privateJson({ error: "Unknown action" }, { status: 400 });
}
