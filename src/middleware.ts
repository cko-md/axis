import { createServerClient } from "@supabase/ssr/dist/module/createServerClient";
import { NextResponse, type NextRequest } from "next/server";

const PUBLIC_PATHS = ["/login", "/auth/callback", "/terms", "/privacy"];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

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

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // API routes never redirect to the login page.
  // Financial, AI, and data-mutation routes require a session — returning 401
  // provides defense-in-depth on top of per-route auth guards.
  // Widget routes are intentionally left open. /api/spotify/auth issues its
  // own redirect-to-provider and is guarded below the same as other actions.
  if (pathname.startsWith("/api")) {
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
      // Note: /api/cron uses CRON_SECRET bearer auth, not user session
    ];
    if (!user && GUARDED_PREFIXES.some((p) => pathname.startsWith(p))) {
      return NextResponse.json({ error: "UNAUTHORIZED", message: "Sign in required." }, { status: 401 });
    }
    return supabaseResponse;
  }

  const isPublic = pathname === "/" || PUBLIC_PATHS.some((p) => pathname.startsWith(p));
  if (!user && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("redirect", pathname);
    return NextResponse.redirect(url);
  }

  if (user && pathname === "/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/console";
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
