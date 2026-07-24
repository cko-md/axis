import { createAdminClient } from "@/lib/supabase/admin";
import { encrypt, decrypt } from "@/lib/crypto";
import * as Sentry from "@sentry/nextjs";

/**
 * Plaid access-token storage, modeled on src/lib/calendar/tokens.ts.
 *
 * Tokens are stored AES-256-GCM encrypted (via src/lib/crypto.ts) in the
 * `fund_connections` table — the same table used for the "public" brokerage
 * provider — never in plaintext, and never returned to the client.
 *
 * AXIS currently permits exactly one verified Plaid Item per user. This helper
 * fails closed if storage violates that invariant; it never chooses a
 * "latest" row or treats corrupt ciphertext as an ordinary disconnect.
 */

const PROVIDER = "plaid";
export class PlaidCredentialStoreError extends Error {
  readonly code = "PLAID_CREDENTIAL_STORE_UNAVAILABLE";

  constructor() {
    super("Plaid credential store unavailable");
    this.name = "PlaidCredentialStoreError";
  }
}

function captureCredentialStoreFailure(operation: string, code: string) {
  Sentry.captureException(new PlaidCredentialStoreError(), {
    tags: { area: "fund", provider: "plaid", operation, code },
  });
}

export type PlaidAccessConnection = {
  id: string;
  itemId: string;
  institution: string | null;
  accessToken: string;
};

/**
 * Returns zero or one verified Plaid connection. Invalid rows, duplicate
 * linked Items, and decryption failures make the credential store unavailable.
 */
export async function getPlaidAccessConnections(userId: string): Promise<PlaidAccessConnection[]> {
  let supabase: ReturnType<typeof createAdminClient>;
  try {
    supabase = createAdminClient();
  } catch {
    captureCredentialStoreFailure("load_token", "admin_client_failed");
    throw new PlaidCredentialStoreError();
  }
  if (!supabase) {
    captureCredentialStoreFailure("load_token", "admin_client_unavailable");
    throw new PlaidCredentialStoreError();
  }
  const { data, error } = await supabase
    .from("fund_connections")
    .select("id, item_id, institution, access_token_enc")
    .eq("user_id", userId)
    .eq("provider", PROVIDER)
    .eq("status", "linked")
    .eq("authority", "provider_verified")
    .order("id", { ascending: true })
    .limit(2);

  if (error) {
    captureCredentialStoreFailure("load_token", "select_failed");
    throw new PlaidCredentialStoreError();
  }
  if (!data || data.length === 0) return [];
  if (data.length > 1) {
    captureCredentialStoreFailure("load_token", "single_item_invariant_failed");
    throw new PlaidCredentialStoreError();
  }
  const connections: PlaidAccessConnection[] = [];
  for (const row of data) {
    if (
      typeof row.id !== "string"
      || typeof row.item_id !== "string"
      || typeof row.access_token_enc !== "string"
    ) {
      captureCredentialStoreFailure("load_token", "credential_row_invalid");
      throw new PlaidCredentialStoreError();
    }
    let accessToken: string | null;
    try {
      accessToken = decrypt(row.access_token_enc);
    } catch {
      captureCredentialStoreFailure("load_token", "decrypt_failed");
      throw new PlaidCredentialStoreError();
    }
    if (!accessToken) {
      captureCredentialStoreFailure("load_token", "decrypt_failed");
      throw new PlaidCredentialStoreError();
    }
    connections.push({
      id: row.id,
      itemId: row.item_id,
      institution: typeof row.institution === "string" ? row.institution : null,
      accessToken,
    });
  }
  return connections;
}

/**
 * Compatibility boundary for operations that consume the single linked Item.
 */
export async function getPlaidAccessToken(userId: string): Promise<string | null> {
  const connections = await getPlaidAccessConnections(userId);
  return connections.length === 1 ? connections[0].accessToken : null;
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

  let supabase: ReturnType<typeof createAdminClient>;
  try {
    supabase = createAdminClient();
  } catch {
    captureCredentialStoreFailure("save_token", "admin_client_failed");
    return false;
  }
  if (!supabase) {
    captureCredentialStoreFailure("save_token", "admin_client_unavailable");
    return false;
  }
  const verifiedAt = new Date().toISOString();
  const { error } = await supabase.from("fund_connections").upsert(
    {
      user_id: userId,
      provider: PROVIDER,
      item_id: itemId,
      institution,
      status: "linked",
      authority: "provider_verified",
      verified_at: verifiedAt,
      access_token_enc: accessEnc,
      updated_at: verifiedAt,
    },
    { onConflict: "user_id,provider,item_id" },
  );

  if (error) {
    captureCredentialStoreFailure("save_token", "upsert_failed");
    return false;
  }
  return true;
}

/** Marks a Plaid connection as revoked (soft delete, mirrors status check constraint). */
export async function revokePlaidConnection(userId: string, itemId: string): Promise<void> {
  let supabase: ReturnType<typeof createAdminClient>;
  try {
    supabase = createAdminClient();
  } catch {
    captureCredentialStoreFailure("revoke_token", "admin_client_failed");
    throw new PlaidCredentialStoreError();
  }
  if (!supabase) {
    captureCredentialStoreFailure("revoke_token", "admin_client_unavailable");
    throw new PlaidCredentialStoreError();
  }
  const { error } = await supabase
    .from("fund_connections")
    .update({
      status: "revoked",
      authority: "legacy_unknown",
      verified_at: null,
      access_token_enc: null,
      refresh_token_enc: null,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId)
    .eq("provider", PROVIDER)
    .eq("item_id", itemId);
  if (error) {
    captureCredentialStoreFailure("revoke_token", "update_failed");
    throw new PlaidCredentialStoreError();
  }
}

/** Server-route disconnect boundary keyed by the safe local connection id. */
export async function revokePlaidConnectionById(
  userId: string,
  connectionId: string,
): Promise<boolean> {
  let supabase: ReturnType<typeof createAdminClient>;
  try {
    supabase = createAdminClient();
  } catch {
    captureCredentialStoreFailure("revoke_connection", "admin_client_failed");
    throw new PlaidCredentialStoreError();
  }
  if (!supabase) {
    captureCredentialStoreFailure("revoke_connection", "admin_client_unavailable");
    throw new PlaidCredentialStoreError();
  }
  const { data, error } = await supabase
    .from("fund_connections")
    .update({
      status: "revoked",
      authority: "legacy_unknown",
      verified_at: null,
      access_token_enc: null,
      refresh_token_enc: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", connectionId)
    .eq("user_id", userId)
    .eq("provider", PROVIDER)
    .select("id")
    .maybeSingle();
  if (error) {
    captureCredentialStoreFailure("revoke_connection", "update_failed");
    throw new PlaidCredentialStoreError();
  }
  return data?.id === connectionId;
}
