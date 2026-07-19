import { createServerClient } from "@supabase/ssr/dist/module/createServerClient";
import { NextResponse, type NextRequest } from "next/server";
import { buildAppUrl } from "@/lib/auth/getAppOrigin";
import {
  isMfaBootstrapApiPath,
  requireAuthenticatorAssurance,
  type AuthenticatorAssuranceState,
} from "@/lib/auth/authenticatorAssurance";
import { MFA_TRUST_COOKIE, verifyMfaTrustToken } from "@/lib/auth/mfaTrust";
import { captureRouteError } from "@/lib/observability/captureRouteError";
import { isPublicVectorArtifactPath } from "@/lib/vector/public-artifacts";

// /oauth-done is the return leg of EVERY provider popup (Spotify, Strava,
// Composio). It is a client-only shim: it reads `provider` and `status` from the
// query string, postMessages them to window.opener, and closes. It carries no
// user data and reads no session.
//
// It must be public. Gating it meant the popup returning from the provider was
// evaluated for both a session AND authenticator assurance, and any miss
// redirected the popup to /login — so the grant succeeded upstream, the opener
// never received its postMessage, and the app silently stayed "not connected".
// Its signed-out fallback still navigates to a protected destination, so making
// this page public does not widen access to anything behind it.
const PUBLIC_PATHS = ["/login", "/auth/callback", "/terms", "/privacy", "/oauth-done"];

// request.nextUrl.clone() inherits Next's NextURL bug where 127.0.0.1/[::1]
// get silently rewritten to the literal string "localhost" at parse time (see
// the long comment in getAppOrigin.ts) — so a plain `.clone()` redirect issued
// while browsing via 127.0.0.1 bounces the browser to a DIFFERENT origin
// (localhost), dropping the session's cookies (origin-scoped) entirely. Build
// the redirect target from buildAppUrl (reads the raw Host header) instead.
function redirectWithinApp(request: NextRequest, pathname: string, search?: URLSearchParams): NextResponse {
  const url = buildAppUrl(request, pathname);
  if (search) url.search = search.toString();
  return NextResponse.redirect(url);
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Offline executable/art manifests are public, immutable inputs. They must
  // bypass session refresh so install verification never receives Set-Cookie.
  if (isPublicVectorArtifactPath(pathname)) {
    return NextResponse.next({ request });
  }

  // Skip auth entirely for purely public/keyless routes — avoids a DB round-trip
  const PUBLIC_API_PREFIXES = [
    "/api/widgets/",
    "/api/literature",
    "/api/gallery",
    // Auth routes that don't require a session (pre-login flows)
    "/api/auth/forgot-password",
    "/api/auth/passkey/authenticate", // login-time: no session yet
    "/api/spotify/callback",          // OAuth redirect from Spotify
    "/api/plaid/webhook",             // Inbound from Plaid — self-authenticates via signed JWT
    "/api/webhooks/make",             // Inbound from Make — self-authenticates via shared secret + HMAC
  ];
  if (PUBLIC_API_PREFIXES.some((p) => pathname.startsWith(p))) {
    return NextResponse.next({ request });
  }

  let supabaseResponse = NextResponse.next({ request });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return supabaseResponse;
  }

  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) {
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

  let user = null;
  let assurance: AuthenticatorAssuranceState = "satisfied";
  try {
    const { data, error } = await supabase.auth.getUser();
    if (error?.code === "refresh_token_not_found" || error?.code === "invalid_refresh_token") {
      request.cookies
        .getAll()
        .filter((cookie) => cookie.name.startsWith("sb-") && cookie.name.includes("auth-token"))
        .forEach((cookie) => {
          supabaseResponse.cookies.set(cookie.name, "", {
            path: "/",
            maxAge: 0,
            sameSite: "lax",
          });
        });
    }
    user = data.user;
    if (user) {
      assurance = await requireAuthenticatorAssurance(supabase);
      // A remembered device lets an enrolled account skip the second factor for
      // a bounded window instead of being challenged on every single sign-in.
      // Only ever narrows mfa_required -> satisfied: `unavailable` still fails
      // closed, and `user` here is already server-verified by getUser() above,
      // so this can elevate a session but can never create one.
      if (assurance === "mfa_required") {
        const verdict = await verifyMfaTrustToken({
          secret: process.env.MFA_TRUST_SECRET,
          token: request.cookies.get(MFA_TRUST_COOKIE)?.value,
          userId: user.id,
          nowMs: Date.now(),
        });
        if (verdict.trusted) assurance = "satisfied";
      }
    }
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "refresh_token_not_found" || code === "invalid_refresh_token") {
      request.cookies
        .getAll()
        .filter((cookie) => cookie.name.startsWith("sb-") && cookie.name.includes("auth-token"))
        .forEach((cookie) => {
          supabaseResponse.cookies.set(cookie.name, "", {
            path: "/",
            maxAge: 0,
            sameSite: "lax",
          });
        });
    } else {
      throw error;
    }
  }

  // API routes never redirect to the login page.
  // Financial, AI, and data-mutation routes require a session — returning 401
  // provides defense-in-depth on top of per-route auth guards.
  // Widget routes are intentionally left open. /api/spotify/auth issues its
  // own redirect-to-provider and is guarded below the same as other actions.
  if (pathname.startsWith("/api")) {
    if (
      user
      && assurance !== "satisfied"
      && !isMfaBootstrapApiPath(pathname)
    ) {
      if (assurance === "mfa_required") {
        return NextResponse.json(
          {
            error: "MFA_REQUIRED",
            message: "Complete two-factor authentication to continue.",
          },
          { status: 403 },
        );
      }
      captureRouteError(new Error("Authenticator assurance unavailable"), {
        route: "middleware",
        operation: "check_authenticator_assurance",
        area: "auth",
        status: 503,
        code: "AUTH_ASSURANCE_UNAVAILABLE",
      });
      return NextResponse.json(
        {
          error: "AUTH_ASSURANCE_UNAVAILABLE",
          message: "Authentication assurance could not be verified.",
        },
        { status: 503 },
      );
    }

    const GUARDED_PREFIXES = [
      "/api/massive",
      "/api/plaid",
      "/api/brokerage",
      "/api/fund",
      "/api/ai",
      "/api/signals-ai",
      "/api/strava",
      "/api/spotify",
      "/api/profile",
      "/api/auth/passkey/register",
      "/api/auth/passkey/token",
      "/api/auth/passkey/list",
      "/api/auth/passkey/delete",
      "/api/auth/settings",
      "/api/auth/mfa",
      "/api/auth/account",
      "/api/calendar",
      "/api/mail",
      "/api/briefing",
      "/api/entities",
      "/api/entity-references",
      "/api/vector",
      // Note: /api/cron uses CRON_SECRET bearer auth, not user session
    ];
    if (!user && GUARDED_PREFIXES.some((p) => pathname.startsWith(p))) {
      return NextResponse.json({ error: "UNAUTHORIZED", message: "Sign in required." }, { status: 401 });
    }
    return supabaseResponse;
  }

  const isPublic = pathname === "/" || PUBLIC_PATHS.some((p) => pathname.startsWith(p));
  if (!user && !isPublic) {
    // Preserve canonical entity selection and the opaque `ws` workspace state
    // across authentication. The login page re-validates this as a same-origin
    // relative path before navigating, so query preservation does not widen the
    // redirect boundary.
    const search = new URLSearchParams({ redirect: `${pathname}${request.nextUrl.search}` });
    return redirectWithinApp(request, "/login", search);
  }

  if (user && assurance === "mfa_required" && !isPublic) {
    const search = new URLSearchParams({
      mfa: "required",
      redirect: `${pathname}${request.nextUrl.search}`,
    });
    return redirectWithinApp(request, "/login", search);
  }

  if (user && assurance === "unavailable" && !isPublic) {
    captureRouteError(new Error("Authenticator assurance unavailable"), {
      route: "middleware",
      operation: "check_authenticator_assurance",
      area: "auth",
      status: 503,
      code: "AUTH_ASSURANCE_UNAVAILABLE",
    });
    const search = new URLSearchParams({
      authError: "assurance_unavailable",
      redirect: `${pathname}${request.nextUrl.search}`,
    });
    return redirectWithinApp(request, "/login", search);
  }

  if (user && assurance === "satisfied" && pathname === "/login") {
    return redirectWithinApp(request, "/command");
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
