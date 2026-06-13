import { NextResponse } from "next/server";
import { cookies } from "next/headers";

/** POST /api/spotify/disconnect — clears stored tokens (server-side only). */
export async function POST() {
  const cookieStore = await cookies();
  cookieStore.delete("spotify_access_token");
  cookieStore.delete("spotify_refresh_token");
  return NextResponse.json({ ok: true, connected: false });
}
