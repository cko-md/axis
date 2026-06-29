import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";

const CLIENT_ID    = process.env.WHOOP_CLIENT_ID;
const REDIRECT_URI = process.env.NEXT_PUBLIC_BASE_URL
  ? `${process.env.NEXT_PUBLIC_BASE_URL}/api/health/whoop/callback`
  : "http://localhost:3000/api/health/whoop/callback";

export async function GET() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!CLIENT_ID) {
    return NextResponse.json(
      { message: "Whoop integration requires WHOOP_CLIENT_ID in environment." },
      { status: 501 },
    );
  }

  const state = crypto.randomUUID();
  const cookieStore = await cookies();
  cookieStore.set("whoop_oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 600,
    path: "/",
  });

  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: "read:recovery read:cycles read:sleep read:workout read:profile read:body_measurement",
    state,
  });

  return NextResponse.redirect(
    `https://api.prod.whoop.com/oauth/oauth2/auth?${params.toString()}`,
  );
}
