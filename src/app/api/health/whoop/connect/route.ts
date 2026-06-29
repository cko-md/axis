import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { optionalEnv } from "@/lib/env";

function redirectUri() {
  const baseUrl = optionalEnv("NEXT_PUBLIC_BASE_URL") ?? "http://localhost:3000";
  return `${baseUrl}/api/health/whoop/callback`;
}

export async function GET() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const clientId = optionalEnv("WHOOP_CLIENT_ID");
  if (!clientId) {
    return NextResponse.json(
      { error: "NOT_CONFIGURED", message: "Whoop integration requires WHOOP_CLIENT_ID in environment." },
      { status: 503 },
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
    client_id: clientId,
    redirect_uri: redirectUri(),
    scope: "read:recovery read:cycles read:sleep read:workout read:profile read:body_measurement",
    state,
  });

  return NextResponse.redirect(
    `https://api.prod.whoop.com/oauth/oauth2/auth?${params.toString()}`,
  );
}
