import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";

/** POST /api/spotify/disconnect — clears stored tokens (server-side only). */
export async function POST() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  cookieStore.delete("spotify_access_token");
  cookieStore.delete("spotify_refresh_token");
  cookieStore.delete("spotify_token_owner");
  return NextResponse.json({ ok: true, connected: false });
}
