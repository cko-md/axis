import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";

const CLIENT_ID    = process.env.GARMIN_CLIENT_ID;
const REDIRECT_URI = process.env.NEXT_PUBLIC_BASE_URL
  ? `${process.env.NEXT_PUBLIC_BASE_URL}/api/health/garmin/callback`
  : "http://localhost:3000/api/health/garmin/callback";

export async function GET() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!CLIENT_ID) {
    return NextResponse.json(
      { message: "Garmin integration requires GARMIN_CLIENT_ID in environment." },
      { status: 501 },
    );
  }

  const state = crypto.randomUUID();
  const cookieStore = await cookies();
  cookieStore.set("garmin_oauth_state", state, {
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
    scope: "ACTIVITY_EXPORT HEART_RATE SLEEP",
    state,
  });

  return NextResponse.redirect(
    `https://connect.garmin.com/oauthConfirm?${params.toString()}`,
  );
}
