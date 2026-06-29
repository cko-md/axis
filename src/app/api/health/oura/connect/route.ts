import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { optionalEnv } from "@/lib/env";

function redirectUri() {
  const baseUrl = optionalEnv("NEXT_PUBLIC_BASE_URL") ?? "http://localhost:3000";
  return `${baseUrl}/api/health/oura/callback`;
}

export async function GET() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const clientId = optionalEnv("OURA_CLIENT_ID");
  if (!clientId) {
    return NextResponse.json(
      { error: "NOT_CONFIGURED", message: "Oura integration requires OURA_CLIENT_ID in environment." },
      { status: 503 },
    );
  }

  const state = crypto.randomUUID();
  const cookieStore = await cookies();
  cookieStore.set("oura_oauth_state", state, {
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
    scope: "daily heartrate workout tag session",
    state,
  });

  return NextResponse.redirect(
    `https://cloud.ouraring.com/oauth/authorize?${params.toString()}`,
  );
}
