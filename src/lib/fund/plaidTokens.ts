import { createClient } from "@/lib/supabase/server";
import { encrypt, decrypt } from "@/lib/crypto";
import * as Sentry from "@sentry/nextjs";

/**
 * Plaid access-token storage, modeled on src/lib/calendar/tokens.ts.
 *
 * Tokens are stored AES-256-GCM encrypted (via src/lib/crypto.ts) in the
 * `fund_connections` table — the same table used for the "public" brokerage
 * provider — never in plaintext, and never returned to the client.
 *
 * fund_connections has a UNIQUE(user_id, provider, item_id) constraint, so a
 * user can link multiple Plaid items (e.g. multiple banks); reads here use
 * the most recently updated linked item for "the" Plaid connection.
 */

const PROVIDER = "plaid";

/**
 * Returns the decrypted access_token for the user's most recently linked
 * Plaid item, or null if no item is linked / decryption fails (e.g. missing
 * PASSKEY_ENCRYPTION_KEY).
 */
export async function getPlaidAccessToken(userId: string): Promise<string | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("fund_connections")
    .select("access_token_enc")
    .eq("user_id", userId)
    .eq("provider", PROVIDER)
    .eq("status", "linked")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    Sentry.captureException(error, {
      tags: { area: "fund", provider: "plaid", operation: "load_token" },
    });
    throw error;
  }
  if (!data?.access_token_enc) return null;
  return decrypt(data.access_token_enc);
}

/**
 * Encrypts and upserts a Plaid connection for the user, keyed by
 * (user_id, provider, item_id) — the table's unique constraint — so
 * re-linking the same institution updates the existing row instead of
 * duplicating it.
 *
 * Returns true on success, false if the access token couldn't be encrypted
 * (no PASSKEY_ENCRYPTION_KEY configured) or the upsert failed.
 */
export async function savePlaidConnection(
  userId: string,
  accessToken: string,
  itemId: string,
  institution: string | null,
): Promise<boolean> {
  const accessEnc = encrypt(accessToken);
  if (!accessEnc) {
    Sentry.captureException(new Error("Plaid token encryption failed"), {
      tags: { area: "fund", provider: "plaid", operation: "save_token", code: "encryption_failed" },
    });
    return false;
  }

  const supabase = await createClient();
  const { error } = await supabase.from("fund_connections").upsert(
    {
      user_id: userId,
      provider: PROVIDER,
      item_id: itemId,
      institution,
      status: "linked",
      access_token_enc: accessEnc,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,provider,item_id" },
  );

  if (error) {
    Sentry.captureException(error, {
      tags: { area: "fund", provider: "plaid", operation: "save_token" },
    });
    return false;
  }
  return true;
}

/** Marks a Plaid connection as revoked (soft delete, mirrors status check constraint). */
export async function revokePlaidConnection(userId: string, itemId: string): Promise<void> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("fund_connections")
    .update({ status: "revoked", updated_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("provider", PROVIDER)
    .eq("item_id", itemId);
  if (error) {
    Sentry.captureException(error, {
      tags: { area: "fund", provider: "plaid", operation: "revoke_token" },
    });
    throw error;
  }
}
