import { createClient } from "@/lib/supabase/server";
import { encrypt, decrypt } from "@/lib/crypto";

interface ContactsTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  email: string;
}

export async function saveContactsTokens(
  userId: string,
  accessToken: string,
  refreshToken: string | null,
  expiresInSeconds: number,
  email: string,
): Promise<void> {
  const supabase = await createClient();
  const accessEnc = encrypt(accessToken);
  const refreshEnc = refreshToken ? encrypt(refreshToken) : null;
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();

  await supabase.from("contacts_connections").upsert(
    {
      user_id: userId,
      provider: "google",
      access_token_enc: accessEnc,
      refresh_token_enc: refreshEnc,
      expires_at: expiresAt,
      email,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,provider" },
  );
}

export async function getContactsTokens(userId: string): Promise<ContactsTokens | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("contacts_connections")
    .select("access_token_enc, refresh_token_enc, expires_at, email")
    .eq("user_id", userId)
    .eq("provider", "google")
    .single();

  if (!data) return null;
  const accessToken = decrypt(data.access_token_enc);
  if (!accessToken) return null;

  return {
    accessToken,
    refreshToken: data.refresh_token_enc ? decrypt(data.refresh_token_enc) : null,
    expiresAt: data.expires_at ? new Date(data.expires_at) : null,
    email: data.email as string,
  };
}
