import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { saveTokens, type CalendarProvider } from "@/lib/calendar/tokens";
import { getAppOrigin } from "@/lib/auth/getAppOrigin";

export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieStore = await cookies();
  const saved = cookieStore.get("calendar_oauth_state")?.value;

  if (!code || !state || state !== saved) {
    return NextResponse.redirect(new URL("/oauth-done?provider=google_calendar&status=error", req.url));
  }

  const provider = state.split(":")[0] as CalendarProvider;
  if (provider !== "google" && provider !== "outlook") {
    return NextResponse.redirect(new URL("/oauth-done?provider=google_calendar&status=error", req.url));
  }

  cookieStore.delete("calendar_oauth_state");

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL("/login", req.url));

  const redirectUri = `${getAppOrigin(req)}/api/calendar/callback`;

  let tokenData: { access_token: string; refresh_token?: string; expires_in?: number } | null = null;
  let calendarEmail: string | undefined;

  if (provider === "google") {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID ?? "",
        client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    if (!res.ok) return NextResponse.redirect(new URL("/oauth-done?provider=google_calendar&status=error", req.url));
    tokenData = await res.json();

    // Fetch the user's Google email
    const profileRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokenData!.access_token}` },
    });
    if (profileRes.ok) {
      const profile = await profileRes.json();
      calendarEmail = profile.email as string | undefined;
    }
  } else {
    const res = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: process.env.MICROSOFT_CLIENT_ID ?? "",
        client_secret: process.env.MICROSOFT_CLIENT_SECRET ?? "",
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
        scope: "Calendars.ReadWrite offline_access User.Read",
      }),
    });
    if (!res.ok) return NextResponse.redirect(new URL("/oauth-done?provider=google_calendar&status=error", req.url));
    tokenData = await res.json();

    const profileRes = await fetch("https://graph.microsoft.com/v1.0/me", {
      headers: { Authorization: `Bearer ${tokenData!.access_token}` },
    });
    if (profileRes.ok) {
      const profile = await profileRes.json();
      calendarEmail = (profile.mail ?? profile.userPrincipalName) as string | undefined;
    }
  }

  if (!tokenData?.access_token) {
    return NextResponse.redirect(new URL("/oauth-done?provider=google_calendar&status=error", req.url));
  }

  await saveTokens(
    user.id,
    provider,
    tokenData.access_token,
    tokenData.refresh_token ?? null,
    tokenData.expires_in ?? 3600,
    calendarEmail,
  );

  return NextResponse.redirect(new URL("/oauth-done?provider=google_calendar&status=ok", req.url));
}
