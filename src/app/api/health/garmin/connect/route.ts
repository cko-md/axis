import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { optionalEnv } from "@/lib/env";

function redirectUri() {
  const baseUrl = optionalEnv("NEXT_PUBLIC_BASE_URL") ?? "http://localhost:3000";
  return `${baseUrl}/api/health/garmin/callback`;
}

export async function GET() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const clientId = optionalEnv("GARMIN_CLIENT_ID");
  if (!clientId) {
    return NextResponse.json(
      { error: "NOT_CONFIGURED", message: "Garmin integration requires GARMIN_CLIENT_ID in environment." },
      { status: 503 },
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
    client_id: clientId,
    redirect_uri: redirectUri(),
    scope: "ACTIVITY_EXPORT HEART_RATE SLEEP",
    state,
  });

  return NextResponse.redirect(
    `https://connect.garmin.com/oauthConfirm?${params.toString()}`,
  );
}
