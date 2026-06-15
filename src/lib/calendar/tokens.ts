import { createClient } from "@/lib/supabase/server";
import { encrypt, decrypt } from "@/lib/crypto";

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
) {
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

export async function deleteTokens(userId: string, provider: CalendarProvider) {
  const supabase = await createClient();
  await supabase
    .from("calendar_connections")
    .delete()
    .eq("user_id", userId)
    .eq("provider", provider);
}

/** Returns a valid access token, refreshing if within 5 minutes of expiry. */
export async function getFreshAccessToken(
  userId: string,
  provider: CalendarProvider,
): Promise<string | null> {
  const tokens = await getTokens(userId, provider);
  if (!tokens) return null;

  const needsRefresh =
    tokens.expiresAt && tokens.expiresAt.getTime() - Date.now() < 5 * 60 * 1000;

  if (!needsRefresh) return tokens.accessToken;
  if (!tokens.refreshToken) return null;

  const refreshed =
    provider === "google"
      ? await refreshGoogle(tokens.refreshToken)
      : await refreshOutlook(tokens.refreshToken);

  if (!refreshed) return null;

  await saveTokens(userId, provider, refreshed.accessToken, tokens.refreshToken, refreshed.expiresIn, tokens.calendarEmail ?? undefined);
  return refreshed.accessToken;
}

async function refreshGoogle(refreshToken: string) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) return null;
  const json = await res.json();
  return { accessToken: json.access_token as string, expiresIn: (json.expires_in as number) ?? 3600 };
}

async function refreshOutlook(refreshToken: string) {
  const res = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.MICROSOFT_CLIENT_ID ?? "",
      client_secret: process.env.MICROSOFT_CLIENT_SECRET ?? "",
      refresh_token: refreshToken,
      grant_type: "refresh_token",
      scope: "Calendars.ReadWrite offline_access",
    }),
  });
  if (!res.ok) return null;
  const json = await res.json();
  return { accessToken: json.access_token as string, expiresIn: (json.expires_in as number) ?? 3600 };
}
