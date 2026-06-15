import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";

const GMAIL_SCOPES =
  "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/userinfo.email";
const OUTLOOK_MAIL_SCOPES = "Mail.Read offline_access User.Read";

export async function GET(req: NextRequest) {
  const provider = req.nextUrl.searchParams.get("provider");
  if (provider !== "gmail" && provider !== "outlook") {
    return NextResponse.json({ error: "provider must be gmail or outlook" }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  const state = `${provider}:${crypto.randomUUID()}`;
  const cookieStore = await cookies();
  cookieStore.set("mail_oauth_state", state, { httpOnly: true, maxAge: 600, path: "/" });

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3200";
  const redirectUri = `${appUrl}/api/mail/callback`;

  let authUrl: string;
  if (provider === "gmail") {
    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID ?? "",
      redirect_uri: redirectUri,
      response_type: "code",
      scope: GMAIL_SCOPES,
      access_type: "offline",
      prompt: "consent",
      state,
    });
    authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  } else {
    const params = new URLSearchParams({
      client_id: process.env.MICROSOFT_CLIENT_ID ?? "",
      redirect_uri: redirectUri,
      response_type: "code",
      scope: OUTLOOK_MAIL_SCOPES,
      state,
    });
    authUrl = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params}`;
  }

  return NextResponse.redirect(authUrl);
}
