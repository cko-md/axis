import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { saveContactsTokens } from "@/lib/contacts/tokens";
import { getAppOrigin } from "@/lib/auth/getAppOrigin";

export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieStore = await cookies();
  const saved = cookieStore.get("contacts_oauth_state")?.value;

  if (!code || !state || state !== saved) {
    return NextResponse.redirect(new URL("/oauth-done?provider=contacts&status=error", req.url));
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL("/login", req.url));

  const redirectUri = `${getAppOrigin(req)}/api/contacts/callback`;

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
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

  if (!tokenRes.ok) {
    return NextResponse.redirect(new URL("/oauth-done?provider=contacts&status=error", req.url));
  }

  const tokenData = await tokenRes.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  if (!tokenData.access_token) {
    return NextResponse.redirect(new URL("/oauth-done?provider=contacts&status=error", req.url));
  }

  const profileRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });

  if (!profileRes.ok) {
    return NextResponse.redirect(new URL("/oauth-done?provider=contacts&status=error", req.url));
  }

  const profile = await profileRes.json() as { email?: string };
  if (!profile.email) {
    return NextResponse.redirect(new URL("/oauth-done?provider=contacts&status=error", req.url));
  }

  await saveContactsTokens(
    user.id,
    tokenData.access_token,
    tokenData.refresh_token ?? null,
    tokenData.expires_in ?? 3600,
    profile.email,
  );

  cookieStore.delete("contacts_oauth_state");

  return NextResponse.redirect(new URL("/oauth-done?provider=contacts&status=ok", req.url));
}
