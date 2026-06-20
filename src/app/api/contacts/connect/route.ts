import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { getAppOrigin } from "@/lib/auth/getAppOrigin";

const CONTACTS_SCOPES =
  "https://www.googleapis.com/auth/contacts.readonly https://www.googleapis.com/auth/userinfo.email";

export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  const state = crypto.randomUUID();
  const cookieStore = await cookies();
  cookieStore.set("contacts_oauth_state", state, { httpOnly: true, maxAge: 600, path: "/" });

  const redirectUri = `${getAppOrigin(req)}/api/contacts/callback`;

  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID ?? "",
    redirect_uri: redirectUri,
    response_type: "code",
    scope: CONTACTS_SCOPES,
    access_type: "offline",
    prompt: "consent",
    state,
  });

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  return NextResponse.redirect(authUrl);
}
