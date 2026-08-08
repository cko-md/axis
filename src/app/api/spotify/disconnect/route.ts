import { cookies } from "next/headers";
import { validateExpectedProfileSubject } from "@/lib/auth/expectedProfileSubject.server";
import {
  clearProviderTokenCookies,
  clearProviderTokenCookiesForSubject,
} from "@/lib/auth/providerCookies.server";
import { privateJson } from "@/lib/auth/privateNoStore";
import { optionalEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

/** POST /api/spotify/disconnect — clears stored tokens (server-side only). */
export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return privateJson({ error: "UNAUTHORIZED" }, { status: 401 });
  const identity = validateExpectedProfileSubject(req, user.id);
  if (!identity.ok) return identity.response;

  const cookieStore = await cookies();
  const secret = optionalEnv("SPOTIFY_CLIENT_SECRET");
  if (secret) {
    clearProviderTokenCookiesForSubject(
      cookieStore,
      "spotify",
      identity.subject,
      secret,
    );
  } else {
    clearProviderTokenCookies(cookieStore, "spotify");
  }
  return privateJson({ ok: true, connected: false });
}
