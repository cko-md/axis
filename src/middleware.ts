import { createServerClient } from "@supabase/ssr/dist/module/createServerClient";
import { NextResponse, type NextRequest } from "next/server";
import { classifyAccess, requiresSupabaseAuth } from "@/lib/auth/accessPolicy";
import { buildAppUrl } from "@/lib/auth/getAppOrigin";
import {
  isMfaBootstrapApiPath,
  requireAuthenticatorAssurance,
  type AuthenticatorAssuranceState,
} from "@/lib/auth/authenticatorAssurance";
import { MFA_TRUST_COOKIE, verifyMfaTrustToken } from "@/lib/auth/mfaTrust";
import { oauthPendingStateCookieName } from "@/lib/auth/directProviderCookies";
import { privateRedirect } from "@/lib/auth/privateNoStore";
import { isAllowedSupabaseUrl } from "@/lib/auth/supabaseUrl";
import { captureRouteError } from "@/lib/observability/captureRouteError";
import { isPublicVectorArtifactPath } from "@/lib/vector/public-artifacts";

// Exact public assets are intentionally enumerated. Dotted application paths
// stay protected; "/api/vector" remains authenticated by default through
// classifyAccess rather than being treated as a static asset prefix.
const PUBLIC_STATIC_FILES = new Set([
  "/favicon.ico",
  "/manifest.json",
  "/apple-touch-icon.png",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-512-maskable.png",
  "/offline.html",
  "/workbox-f52fd911.js",
]);

function isFrameworkPublicPath(pathname: string): boolean {
  return pathname === "/_next/image"
    || pathname.startsWith("/_next/image/")
    || pathname === "/_next/static"
    || pathname.startsWith("/_next/static/");
}

type AuthError = {
  code?: unknown;
  name?: unknown;
  status?: unknown;
};

function redirectWithinApp(
  request: NextRequest,
  pathname: string,
  search?: URLSearchParams,
): NextResponse {
  const url = buildAppUrl(request, pathname);
  if (search) url.search = search.toString();
  return privateRedirect(url);
}

function carryCookies(source: NextResponse, target: NextResponse): NextResponse {
  source.cookies.getAll().forEach((cookie) => target.cookies.set(cookie));
  return target;
}

function clearBrokenAuthCookies(request: NextRequest, response: NextResponse) {
  request.cookies
    .getAll()
    .filter((cookie) => cookie.name.startsWith("sb-") && cookie.name.includes("auth-token"))
    .forEach((cookie) => {
      response.cookies.set(cookie.name, "", {
        path: "/",
        maxAge: 0,
        sameSite: "lax",
      });
    });
}

function hasSupabaseAuthCookie(request: NextRequest): boolean {
  return request.cookies
    .getAll()
    .some((cookie) => cookie.name.startsWith("sb-") && cookie.name.includes("auth-token"));
}

function authErrorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const code = (error as AuthError).code;
  return typeof code === "string" ? code : "";
}

function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

type DirectOAuthProvider = "spotify" | "strava";

function directOAuthCallbackProvider(request: NextRequest): DirectOAuthProvider | null {
  if (request.method !== "GET") return null;
  if (request.nextUrl.pathname === "/api/spotify/callback") return "spotify";
  if (request.nextUrl.pathname !== "/api/strava") return null;
  const actions = request.nextUrl.searchParams.getAll("action");
  return actions.length === 1 && actions[0] === "callback" ? "strava" : null;
}

function providerAuthFeedback(
  request: NextRequest,
  provider: DirectOAuthProvider,
  reason: string,
): NextResponse {
  const search = new URLSearchParams({
    provider,
    status: "error",
    reason,
  });
  const response = redirectWithinApp(request, "/oauth-done", search);
  response.cookies.set(oauthPendingStateCookieName(provider), "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 0,
    path: "/",
  });
  return response;
}

function isRefreshTokenAbsence(error: unknown): boolean {
  const code = authErrorCode(error);
  return code === "refresh_token_not_found" || code === "invalid_refresh_token";
}

function isSessionMissing(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as AuthError;
  return candidate.name === "AuthSessionMissingError" && candidate.status === 400;
}

function unavailable(
  request: NextRequest,
  code: "AUTH_CONFIGURATION_UNAVAILABLE" | "AUTH_BACKEND_UNAVAILABLE",
) {
  captureRouteError(new Error("Authentication infrastructure unavailable"), {
    route: "middleware",
    operation: "authenticate_request",
    area: "auth",
    status: 503,
    code,
  });
  const callbackProvider = directOAuthCallbackProvider(request);
  if (callbackProvider) {
    return providerAuthFeedback(request, callbackProvider, "auth_unavailable");
  }
  return NextResponse.json(
    {
      error: code,
      message: "Authentication infrastructure is temporarily unavailable.",
    },
    { status: 503 },
  );
}

function observeAssuranceUnavailable() {
  captureRouteError(new Error("Authenticator assurance unavailable"), {
    route: "middleware",
    operation: "check_authenticator_assurance",
    area: "auth",
    status: 503,
    code: "AUTH_ASSURANCE_UNAVAILABLE",
  });
}

function assuranceUnavailable() {
  return NextResponse.json(
    {
      error: "AUTH_ASSURANCE_UNAVAILABLE",
      message: "Authentication assurance could not be verified.",
    },
    { status: 503 },
  );
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Offline executable/art manifests are public, immutable inputs. They must
  // bypass session refresh so install verification never receives Set-Cookie.
  if (
    isFrameworkPublicPath(pathname)
    || isPublicVectorArtifactPath(pathname)
    || PUBLIC_STATIC_FILES.has(pathname)
  ) {
    return NextResponse.next({ request });
  }

  const access = classifyAccess(pathname);
  // The landing page is public during missing configuration and outages, but
  // an existing auth cookie still needs middleware's response-capable refresh
  // path. Server Components cannot persist rotated Supabase cookies.
  const optionalRootSession = pathname === "/" && hasSupabaseAuthCookie(request);
  if (!requiresSupabaseAuth(access) && !optionalRootSession) {
    return NextResponse.next({ request });
  }

  let supabaseResponse = NextResponse.next({ request });
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();

  if (!supabaseUrl || !supabaseAnonKey || !isAllowedSupabaseUrl(supabaseUrl)) {
    if (optionalRootSession) return NextResponse.next({ request });
    return unavailable(request, "AUTH_CONFIGURATION_UNAVAILABLE");
  }

  let supabase;
  try {
    supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    });
  } catch {
    if (optionalRootSession) return NextResponse.next({ request });
    return unavailable(request, "AUTH_CONFIGURATION_UNAVAILABLE");
  }

  let user = null;
  let assurance: AuthenticatorAssuranceState = "satisfied";
  try {
    const { data, error } = await supabase.auth.getUser();
    if (error) {
      if (isRefreshTokenAbsence(error) || isSessionMissing(error)) {
        clearBrokenAuthCookies(request, supabaseResponse);
      } else if (optionalRootSession) {
        return supabaseResponse;
      } else {
        return carryCookies(supabaseResponse, unavailable(request, "AUTH_BACKEND_UNAVAILABLE"));
      }
    } else {
      user = data.user;
    }
  } catch (error) {
    if (isRefreshTokenAbsence(error) || isSessionMissing(error)) {
      clearBrokenAuthCookies(request, supabaseResponse);
    } else if (optionalRootSession) {
      return supabaseResponse;
    } else {
      return carryCookies(supabaseResponse, unavailable(request, "AUTH_BACKEND_UNAVAILABLE"));
    }
  }

  if (!user) {
    if (optionalRootSession || access === "keyless-public" || access === "public-page") {
      return supabaseResponse;
    }
    const callbackProvider = directOAuthCallbackProvider(request);
    if (callbackProvider) {
      return carryCookies(
        supabaseResponse,
        providerAuthFeedback(request, callbackProvider, "session_expired"),
      );
    }
    if (isApiPath(pathname)) {
      return carryCookies(
        supabaseResponse,
        NextResponse.json({ error: "UNAUTHORIZED", message: "Sign in required." }, { status: 401 }),
      );
    }
    const search = new URLSearchParams({ redirect: `${pathname}${request.nextUrl.search}` });
    return carryCookies(supabaseResponse, redirectWithinApp(request, "/login", search));
  }

  assurance = await requireAuthenticatorAssurance(supabase);
  // A remembered device lets an enrolled account skip the second factor for a
  // bounded window. It can only narrow mfa_required after getUser() verifies
  // the session; no token can create a session or override unavailable.
  if (assurance === "mfa_required") {
    const verdict = await verifyMfaTrustToken({
      secret: process.env.MFA_TRUST_SECRET,
      token: request.cookies.get(MFA_TRUST_COOKIE)?.value,
      userId: user.id,
      nowMs: Date.now(),
    });
    if (verdict.trusted) assurance = "satisfied";
  }

  if (assurance === "unavailable") {
    observeAssuranceUnavailable();
    const callbackProvider = directOAuthCallbackProvider(request);
    if (callbackProvider) {
      return carryCookies(
        supabaseResponse,
        providerAuthFeedback(request, callbackProvider, "assurance_unavailable"),
      );
    }
    if (isApiPath(pathname)) {
      return carryCookies(supabaseResponse, assuranceUnavailable());
    }
    if (access === "authenticated") {
      const search = new URLSearchParams({
        authError: "assurance_unavailable",
        redirect: `${pathname}${request.nextUrl.search}`,
      });
      return carryCookies(supabaseResponse, redirectWithinApp(request, "/login", search));
    }
    return supabaseResponse;
  }

  if (assurance === "mfa_required" && access !== "mfa-bootstrap") {
    const callbackProvider = directOAuthCallbackProvider(request);
    if (callbackProvider) {
      return carryCookies(
        supabaseResponse,
        providerAuthFeedback(request, callbackProvider, "mfa_required"),
      );
    }
    if (isApiPath(pathname)) {
      return carryCookies(
        supabaseResponse,
        NextResponse.json(
          { error: "MFA_REQUIRED", message: "Complete two-factor authentication to continue." },
          { status: 403 },
        ),
      );
    }
    if (access === "authenticated") {
      const search = new URLSearchParams({
        mfa: "required",
        redirect: `${pathname}${request.nextUrl.search}`,
      });
      return carryCookies(supabaseResponse, redirectWithinApp(request, "/login", search));
    }
  }

  // Defense in depth: only the exact bootstrap paths can be used while aal1.
  if (access === "mfa-bootstrap" && isApiPath(pathname) && !isMfaBootstrapApiPath(pathname)) {
    return carryCookies(
      supabaseResponse,
      NextResponse.json({ error: "MFA_REQUIRED", message: "Complete two-factor authentication to continue." }, { status: 403 }),
    );
  }

  if (assurance === "satisfied" && pathname === "/login") {
    return carryCookies(supabaseResponse, redirectWithinApp(request, "/command"));
  }

  return supabaseResponse;
}

export const config = {
  // Match every path. Exact framework/static exceptions are enforced above so
  // prefix lookalikes cannot bypass the authenticated default at matcher time.
  matcher: ["/:path*"],
};
