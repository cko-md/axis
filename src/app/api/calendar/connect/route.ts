import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { getAppOrigin } from "@/lib/auth/getAppOrigin";
import { generatePkce } from "@/lib/auth/pkce";

const GOOGLE_SCOPES = "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/userinfo.email";
const OUTLOOK_SCOPES = "Calendars.ReadWrite offline_access User.Read";

export async function GET(req: NextRequest) {
  const provider = req.nextUrl.searchParams.get("provider");
  if (provider !== "google" && provider !== "outlook") {
    return NextResponse.json({ error: "provider must be google or outlook" }, { status: 400 });
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  const state = `${provider}:${crypto.randomUUID()}`;
  const cookieStore = await cookies();
  cookieStore.set("calendar_oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 600,
    path: "/",
  });

  const redirectUri = `${getAppOrigin(req)}/api/calendar/callback`;

  let authUrl: string;
  if (provider === "google") {
    const { verifier, challenge } = generatePkce();
    cookieStore.set("calendar_pkce_verifier", verifier, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 600,
      path: "/",
    });
    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID ?? "",
      redirect_uri: redirectUri,
      response_type: "code",
      scope: GOOGLE_SCOPES,
      access_type: "offline",
      prompt: "consent",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  } else {
    const params = new URLSearchParams({
      client_id: process.env.MICROSOFT_CLIENT_ID ?? "",
      redirect_uri: redirectUri,
      response_type: "code",
      scope: OUTLOOK_SCOPES,
      state,
    });
    authUrl = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params}`;
  }

  return NextResponse.redirect(authUrl);
}
