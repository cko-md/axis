import { createClient } from "@/lib/supabase/server";
import { encrypt, decrypt } from "@/lib/crypto";

export type MailProvider = "gmail" | "outlook";

interface StoredTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  mailEmail: string | null;
}

export async function getMailTokens(userId: string, provider: MailProvider): Promise<StoredTokens | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("mail_connections")
    .select("access_token_enc, refresh_token_enc, expires_at, mail_email")
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
    mailEmail: data.mail_email,
  };
}

export async function saveMailTokens(
  userId: string,
  provider: MailProvider,
  accessToken: string,
  refreshToken: string | null,
  expiresInSeconds: number,
  mailEmail?: string,
) {
  const supabase = await createClient();
  const accessEnc = encrypt(accessToken);
  const refreshEnc = refreshToken ? encrypt(refreshToken) : null;
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();

  await supabase.from("mail_connections").upsert(
    {
      user_id: userId,
      provider,
      access_token_enc: accessEnc,
      refresh_token_enc: refreshEnc,
      expires_at: expiresAt,
      mail_email: mailEmail ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,provider" },
  );
}

export async function deleteMailTokens(userId: string, provider: MailProvider) {
  const supabase = await createClient();
  await supabase
    .from("mail_connections")
    .delete()
    .eq("user_id", userId)
    .eq("provider", provider);
}

export async function getFreshMailAccessToken(
  userId: string,
  provider: MailProvider,
): Promise<string | null> {
  const tokens = await getMailTokens(userId, provider);
  if (!tokens) return null;

  const needsRefresh =
    tokens.expiresAt && tokens.expiresAt.getTime() - Date.now() < 5 * 60 * 1000;

  if (!needsRefresh) return tokens.accessToken;
  if (!tokens.refreshToken) return null;

  const refreshed =
    provider === "gmail"
      ? await refreshGmail(tokens.refreshToken)
      : await refreshOutlookMail(tokens.refreshToken);

  if (!refreshed) return null;

  await saveMailTokens(userId, provider, refreshed.accessToken, tokens.refreshToken, refreshed.expiresIn, tokens.mailEmail ?? undefined);
  return refreshed.accessToken;
}

async function refreshGmail(refreshToken: string) {
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

async function refreshOutlookMail(refreshToken: string) {
  const res = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.MICROSOFT_CLIENT_ID ?? "",
      client_secret: process.env.MICROSOFT_CLIENT_SECRET ?? "",
      refresh_token: refreshToken,
      grant_type: "refresh_token",
      scope: "Mail.Read offline_access User.Read",
    }),
  });
  if (!res.ok) return null;
  const json = await res.json();
  return { accessToken: json.access_token as string, expiresIn: (json.expires_in as number) ?? 3600 };
}
