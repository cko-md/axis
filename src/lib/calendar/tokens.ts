import { createClient } from "@/lib/supabase/server";
import { encrypt, decrypt } from "@/lib/crypto";
import { refreshGoogleOAuth, refreshMicrosoftOAuth } from "@/lib/oauth/refresh";
import type { PostgrestError } from "@supabase/supabase-js";

const TOKEN_REFRESH_THRESHOLD_MS = 5 * 60 * 1000;
const OUTLOOK_CALENDAR_SCOPE = "Calendars.ReadWrite offline_access";

export type CalendarProvider = "google" | "outlook";

interface StoredTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  calendarEmail: string | null;
}

export async function getTokens(userId: string, provider: CalendarProvider): Promise<StoredTokens | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("calendar_connections")
    .select("access_token_enc, refresh_token_enc, expires_at, calendar_email")
    .eq("user_id", userId)
    .eq("provider", provider)
    .single();

  if (!data) return null;
  const accessToken = decrypt(data.access_token_enc);
  if (!accessToken) return null;

  return {
    accessToken,
    refreshToken: data.refresh_token_enc ? decrypt(data.refresh_token_enc) : null,
    expiresAt: data.expires_at ? new Date(data.expires_at) : null,
    calendarEmail: data.calendar_email,
  };
}

export async function saveTokens(
  userId: string,
  provider: CalendarProvider,
  accessToken: string,
  refreshToken: string | null,
  expiresInSeconds: number,
  calendarEmail?: string,
): Promise<void> {
  const supabase = await createClient();
  const accessEnc = encrypt(accessToken);
  const refreshEnc = refreshToken ? encrypt(refreshToken) : null;
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();

  await supabase.from("calendar_connections").upsert(
    {
      user_id: userId,
      provider,
      access_token_enc: accessEnc,
      refresh_token_enc: refreshEnc,
      expires_at: expiresAt,
      calendar_email: calendarEmail ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,provider" },
  );
}

export async function deleteTokens(userId: string, provider: CalendarProvider): Promise<PostgrestError | null> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("calendar_connections")
    .delete()
    .eq("user_id", userId)
    .eq("provider", provider);
  return error;
}

/** Returns a valid access token, refreshing if within 5 minutes of expiry. */
export async function getFreshAccessToken(
  userId: string,
  provider: CalendarProvider,
): Promise<string | null> {
  const tokens = await getTokens(userId, provider);
  if (!tokens) return null;

  const needsRefresh =
    tokens.expiresAt && tokens.expiresAt.getTime() - Date.now() < TOKEN_REFRESH_THRESHOLD_MS;

  if (!needsRefresh) return tokens.accessToken;
  if (!tokens.refreshToken) return null;

  const refreshed =
    provider === "google"
      ? await refreshGoogleOAuth(tokens.refreshToken)
      : await refreshMicrosoftOAuth(tokens.refreshToken, OUTLOOK_CALENDAR_SCOPE);

  if (!refreshed) return null;

  await saveTokens(
    userId,
    provider,
    refreshed.accessToken,
    refreshed.refreshToken ?? tokens.refreshToken,
    refreshed.expiresIn,
    tokens.calendarEmail ?? undefined,
  );
  return refreshed.accessToken;
}
