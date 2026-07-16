import { createClient } from "@/lib/supabase/server";
import { encrypt, decrypt } from "@/lib/crypto";
import { refreshGoogleOAuth, refreshMicrosoftOAuth } from "@/lib/oauth/refresh";
import { listComposioMailAccounts } from "./composio";
import type { PostgrestError } from "@supabase/supabase-js";

const TOKEN_REFRESH_THRESHOLD_MS = 5 * 60 * 1000;
const OUTLOOK_MAIL_SCOPE = "Mail.Read Mail.Send offline_access User.Read";

export type MailProvider = "gmail" | "outlook";

interface StoredTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  mailEmail: string;
}

export async function getMailTokens(
  userId: string,
  provider: MailProvider,
  mailEmail: string,
): Promise<StoredTokens | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("mail_connections")
    .select("access_token_enc, refresh_token_enc, expires_at, mail_email")
    .eq("user_id", userId)
    .eq("provider", provider)
    .eq("mail_email", mailEmail)
    .single();

  if (error && error.code !== "PGRST116") throw error;
  if (!data) return null;
  const accessToken = decrypt(data.access_token_enc);
  if (!accessToken) return null;

  return {
    accessToken,
    refreshToken: data.refresh_token_enc ? decrypt(data.refresh_token_enc) : null,
    expiresAt: data.expires_at ? new Date(data.expires_at) : null,
    mailEmail: data.mail_email as string,
  };
}

export async function saveMailTokens(
  userId: string,
  provider: MailProvider,
  accessToken: string,
  refreshToken: string | null,
  expiresInSeconds: number,
  mailEmail: string,
): Promise<void> {
  const supabase = await createClient();
  const accessEnc = encrypt(accessToken);
  // encrypt() returns null when ENCRYPTION_KEY is missing/misconfigured — never
  // persist a null access token (the column is NOT NULL and a null would be useless).
  if (!accessEnc) throw new Error("Mail token encryption failed — ENCRYPTION_KEY not configured");
  const refreshEnc = refreshToken ? encrypt(refreshToken) : null;
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();

  const { error } = await supabase.from("mail_connections").upsert(
    {
      user_id: userId,
      provider,
      access_token_enc: accessEnc,
      refresh_token_enc: refreshEnc,
      expires_at: expiresAt,
      mail_email: mailEmail,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,provider,mail_email" },
  );
  if (error) throw error;
}

export async function deleteMailTokens(
  userId: string,
  provider: MailProvider,
  mailEmail: string,
): Promise<PostgrestError | null> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("mail_connections")
    .delete()
    .eq("user_id", userId)
    .eq("provider", provider)
    .eq("mail_email", mailEmail);
  return error;
}

export type MailAccountRef = {
  provider: MailProvider;
  mailEmail: string;
  via?: "composio";
  connectedAccountId?: string;
};

export async function listMailAccounts(userId: string): Promise<MailAccountRef[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("mail_connections")
    .select("provider, mail_email")
    .eq("user_id", userId);
  if (error) throw error;

  const oauthAccounts: MailAccountRef[] = (data ?? []).map((row) => ({
    provider: row.provider as MailProvider,
    mailEmail: row.mail_email as string,
  }));

  const composioAccounts = await listComposioMailAccounts(userId);
  const composioRefs: MailAccountRef[] = composioAccounts.map((a) => ({
    provider: a.provider,
    mailEmail: a.mailEmail,
    via: "composio" as const,
    connectedAccountId: a.connectedAccountId,
  }));

  // A given mailbox may only be connected one way at a time — prefer the
  // legacy OAuth row if both somehow exist for the same address.
  const seen = new Set(oauthAccounts.map((a) => `${a.provider}:${a.mailEmail}`));
  return [...oauthAccounts, ...composioRefs.filter((a) => !seen.has(`${a.provider}:${a.mailEmail}`))];
}

export async function getFreshMailAccessToken(
  userId: string,
  provider: MailProvider,
  mailEmail: string,
): Promise<string | null> {
  const tokens = await getMailTokens(userId, provider, mailEmail);
  if (!tokens) return null;

  const needsRefresh =
    tokens.expiresAt && tokens.expiresAt.getTime() - Date.now() < TOKEN_REFRESH_THRESHOLD_MS;

  if (!needsRefresh) return tokens.accessToken;
  if (!tokens.refreshToken) return null;

  const refreshed =
    provider === "gmail"
      ? await refreshGoogleOAuth(tokens.refreshToken)
      : await refreshMicrosoftOAuth(tokens.refreshToken, OUTLOOK_MAIL_SCOPE);

  if (!refreshed) return null;

  await saveMailTokens(
    userId,
    provider,
    refreshed.accessToken,
    refreshed.refreshToken ?? tokens.refreshToken,
    refreshed.expiresIn,
    mailEmail,
  );
  return refreshed.accessToken;
}
