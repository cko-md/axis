import { createServerClient } from "@supabase/ssr/dist/module/createServerClient";
import { NextResponse, type NextRequest } from "next/server";
import { buildAppUrl } from "@/lib/auth/getAppOrigin";
import { classifyAccess, requiresSupabaseAuth } from "@/lib/auth/accessPolicy";
import {
  isMfaBootstrapApiPath,
  requireAuthenticatorAssurance,
  type AuthenticatorAssuranceState,
} from "@/lib/auth/authenticatorAssurance";
import { readMfaTrustEpoch } from "@/lib/auth/securityState";
import {
  isMfaTrustFactorCurrent,
  MFA_TRUST_COOKIE,
  verifyMfaTrustToken,
} from "@/lib/auth/mfaTrust";
import { captureRouteError } from "@/lib/observability/captureRouteError";
import { isPublicVectorArtifactPath } from "@/lib/vector/public-artifacts";
import { reportAuthConfigurationUnavailable } from "@/lib/auth/configPreflight";
import { isAllowedSupabaseUrl } from "@/lib/auth/supabaseUrl";

const PUBLIC_STATIC_FILES = new Set([
  "/manifest.json",
  "/apple-touch-icon.png",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-512-maskable.png",
  "/offline.html",
  "/workbox-f52fd911.js",
]);

function redirectWithinApp(
  request: NextRequest,
  pathname: string,
  search?: URLSearchParams,
): NextResponse {
  const url = buildAppUrl(request, pathname);
  if (search) url.search = search.toString();
  return NextResponse.redirect(url);
}

function unavailable(code: string) {
  captureRouteError(new Error("Authentication infrastructure unavailable"), {
    route: "middleware",
    operation: "authenticate",
    area: "auth",
    status: 503,
    code,
  });
  return NextResponse.json(
    {
      error: code,
      message: "Authentication is temporarily unavailable.",
    },
    { status: 503 },
  );
}

function clearBrokenAuthCookies(
  request: NextRequest,
  response: NextResponse,
) {
  request.cookies
    .getAll()
    .filter(
      (cookie) =>
        cookie.name.startsWith("sb-")
        && cookie.name.includes("auth-token"),
    )
    .forEach((cookie) =>
      response.cookies.set(cookie.name, "", {
        path: "/",
        maxAge: 0,
        sameSite: "lax",
      }),
    );
}

function carryCookies(source: NextResponse, target: NextResponse) {
  source.cookies.getAll().forEach((cookie) => target.cookies.set(cookie));
  return target;
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (
    isPublicVectorArtifactPath(pathname)
    || PUBLIC_STATIC_FILES.has(pathname)
  ) {
    return NextResponse.next({ request });
  }

  const access = classifyAccess(pathname);
  if (!requiresSupabaseAuth(access)) return NextResponse.next({ request });

  let supabaseResponse = NextResponse.next({ request });
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!supabaseUrl || !supabaseAnonKey) {
    reportAuthConfigurationUnavailable();
    return unavailable("AUTH_CONFIGURATION_UNAVAILABLE");
  }
  if (!isAllowedSupabaseUrl(supabaseUrl)) {
    reportAuthConfigurationUnavailable();
    return unavailable("AUTH_CONFIGURATION_UNAVAILABLE");
  }

  let supabase: ReturnType<typeof createServerClient>;
  try {
    supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll(
          cookiesToSet: Array<{
            name: string;
            value: string;
            options?: Record<string, unknown>;
          }>,
        ) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    });
  } catch {
    reportAuthConfigurationUnavailable();
    return unavailable("AUTH_CONFIGURATION_UNAVAILABLE");
  }

  let user: { id: string } | null = null;
  let provenAbsentSession = false;
  try {
    const { data, error } = await supabase.auth.getUser();
    if (error) {
      const hasAuthCookie = request.cookies.getAll().some(
        (cookie) =>
          cookie.name.startsWith("sb-")
          && cookie.name.includes("auth-token"),
      );
      if (
        error.code === "refresh_token_not_found"
        || error.code === "invalid_refresh_token"
      ) {
        clearBrokenAuthCookies(request, supabaseResponse);
        provenAbsentSession = true;
      } else if (
        !hasAuthCookie
        && error.name === "AuthSessionMissingError"
        && error.status === 400
      ) {
        // Supabase reports a normal first-time, cookie-less visitor as an
        // AuthSessionMissingError. Only the exact missing-session shape with no
        // auth cookie proves absence; retryable/network failures remain 503.
        provenAbsentSession = true;
      } else {
        return carryCookies(
          supabaseResponse,
          unavailable("AUTH_BACKEND_UNAVAILABLE"),
        );
      }
    } else {
      user = data.user;
      provenAbsentSession = !user;
    }
  } catch {
    return carryCookies(
      supabaseResponse,
      unavailable("AUTH_BACKEND_UNAVAILABLE"),
    );
  }

  if (!user) {
    if (pathname.startsWith("/api/")) {
      if (access === "keyless-public" && provenAbsentSession) {
        return supabaseResponse;
      }
      return carryCookies(
        supabaseResponse,
        NextResponse.json(
          { error: "UNAUTHORIZED", message: "Sign in required." },
          { status: 401 },
        ),
      );
    }
    if (access === "authenticated" && provenAbsentSession) {
      return carryCookies(
        supabaseResponse,
        redirectWithinApp(
          request,
          "/login",
          new URLSearchParams({
            redirect: `${pathname}${request.nextUrl.search}`,
          }),
        ),
      );
    }
    return supabaseResponse;
  }

  let assurance: AuthenticatorAssuranceState = "satisfied";
  try {
    assurance = await requireAuthenticatorAssurance(supabase);
  } catch {
    return carryCookies(
      supabaseResponse,
      unavailable("AUTH_ASSURANCE_UNAVAILABLE"),
    );
  }
  if (assurance === "mfa_required") {
    const epoch = await readMfaTrustEpoch(supabase, user.id);
    if (epoch !== null) {
      const verdict = await verifyMfaTrustToken({
        secret: process.env.MFA_TRUST_SECRET,
        token: request.cookies.get(MFA_TRUST_COOKIE)?.value,
        userId: user.id,
        trustEpoch: epoch,
        nowMs: Date.now(),
      });
      if (verdict.trusted) {
        let factorsResult;
        try {
          factorsResult = await supabase.auth.mfa.listFactors();
        } catch {
          return carryCookies(
            supabaseResponse,
            unavailable("AUTH_BACKEND_UNAVAILABLE"),
          );
        }
        if (
          factorsResult.error
          || !factorsResult.data
          || !Array.isArray(factorsResult.data.all)
        ) {
          return carryCookies(
            supabaseResponse,
            unavailable("AUTH_BACKEND_UNAVAILABLE"),
          );
        }
        if (
          isMfaTrustFactorCurrent(
            verdict,
            factorsResult.data.all,
          )
        ) {
          assurance = "satisfied";
        }
      }
    }
  }

  if (assurance === "unavailable") {
    return carryCookies(
      supabaseResponse,
      unavailable("AUTH_ASSURANCE_UNAVAILABLE"),
    );
  }
  if (assurance === "mfa_required" && access !== "mfa-bootstrap") {
    if (pathname.startsWith("/api/")) {
      return carryCookies(
        supabaseResponse,
        NextResponse.json(
          {
            error: "MFA_REQUIRED",
            message: "Complete two-factor authentication to continue.",
          },
          { status: 403 },
        ),
      );
    }
    if (access === "authenticated") {
      return carryCookies(
        supabaseResponse,
        redirectWithinApp(
          request,
          "/login",
          new URLSearchParams({
            mfa: "required",
            redirect: `${pathname}${request.nextUrl.search}`,
          }),
        ),
      );
    }
  }

  if (
    access === "mfa-bootstrap"
    && pathname.startsWith("/api/")
    && !isMfaBootstrapApiPath(pathname)
  ) {
    return carryCookies(
      supabaseResponse,
      NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 }),
    );
  }
  if (assurance === "satisfied" && pathname === "/login") {
    return carryCookies(
      supabaseResponse,
      redirectWithinApp(request, "/command"),
    );
  }
  return supabaseResponse;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
