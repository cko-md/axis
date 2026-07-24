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
 * The credential-lockdown migration permits at most one linked Plaid Item per
 * user. The older UNIQUE(user_id, provider, item_id) constraint remains only
 * as row identity; it is not the authority for active-link cardinality.
 */

const PROVIDER = "plaid";

export class PlaidConnectionStoreUnavailableError extends Error {
  constructor(
    public readonly reason: "conflict" | "unavailable" = "unavailable",
  ) {
    super("PLAID_CONNECTION_STORE_UNAVAILABLE");
    this.name = "PlaidConnectionStoreUnavailableError";
  }
}

function requireAdminClient(operation: string) {
  let admin;
  try {
    admin = createAdminClient();
  } catch {
    admin = null;
  }
  if (admin) return admin;
  Sentry.captureException(new Error("Plaid connection service role unavailable"), {
    tags: {
      area: "fund",
      provider: "plaid",
      operation,
      code: "service_role_unavailable",
    },
  });
  throw new PlaidConnectionStoreUnavailableError();
}

/**
 * Returns the decrypted access_token for the user's linked Plaid item, or null
 * only when no linked item exists. Ciphertext that cannot be decrypted is a
 * trusted-store failure and never masquerades as a disconnected account.
 */
export async function getPlaidAccessToken(userId: string): Promise<string | null> {
  const admin = requireAdminClient("load_token");
  const { data, error } = await admin
    .from("fund_connections")
    .select("access_token_enc")
    .eq("user_id", userId)
    .eq("provider", PROVIDER)
    .eq("status", "linked")
    .eq("authority", "provider_verified")
    .not("verified_at", "is", null)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    Sentry.captureException(new Error("Plaid connection lookup failed"), {
      tags: {
        area: "fund",
        provider: "plaid",
        operation: "load_token",
        code: "store_query_failed",
      },
    });
    throw new PlaidConnectionStoreUnavailableError();
  }
  if (data === null) return null;
  const ciphertext = data.access_token_enc;
  let token: string | null = null;
  try {
    token =
      typeof ciphertext === "string" && ciphertext.length > 0
        ? decrypt(ciphertext)
        : null;
  } catch {
    token = null;
  }
  if (token) return token;
  Sentry.captureException(new Error("Plaid token decryption failed"), {
    tags: {
      area: "fund",
      provider: "plaid",
      operation: "load_token",
      code: "decryption_failed",
    },
  });
  throw new PlaidConnectionStoreUnavailableError();
}

/**
 * Encrypts and upserts a Plaid connection for the user. A partial unique index
 * separately enforces at most one active Plaid Item per owner; a concurrent
 * link race therefore fails closed and must be compensated at the provider.
 *
 * Returns true on success and false only when local encryption is unavailable.
 * The trusted store being unavailable throws a sanitized typed error so routes
 * can expose a retryable 503 instead of misreporting "not linked".
 */
export async function savePlaidConnection(
  userId: string,
  accessToken: string,
  itemId: string,
  institution: string | null,
): Promise<boolean> {
  let accessEnc: string | null = null;
  try {
    accessEnc = encrypt(accessToken);
  } catch {
    accessEnc = null;
  }
  if (!accessEnc) {
    Sentry.captureException(new Error("Plaid token encryption failed"), {
      tags: { area: "fund", provider: "plaid", operation: "save_token", code: "encryption_failed" },
    });
    return false;
  }

  const admin = requireAdminClient("save_token");
  const { error } = await admin.from("fund_connections").upsert(
    {
      user_id: userId,
      provider: PROVIDER,
      item_id: itemId,
      institution,
      status: "linked",
      authority: "provider_verified",
      verified_at: new Date().toISOString(),
      access_token_enc: accessEnc,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,provider,item_id" },
  );

  if (error) {
    Sentry.captureException(new Error("Plaid connection persistence failed"), {
      tags: {
        area: "fund",
        provider: "plaid",
        operation: "save_token",
        code:
          error && typeof error === "object" && "code" in error && error.code === "23505"
            ? "active_connection_conflict"
            : "store_write_failed",
      },
    });
    throw new PlaidConnectionStoreUnavailableError(
      error && typeof error === "object" && "code" in error && error.code === "23505"
        ? "conflict"
        : "unavailable",
    );
  }
  return true;
}

/** Marks a Plaid connection as revoked (soft delete, mirrors status check constraint). */
export async function revokePlaidConnection(userId: string, itemId: string): Promise<void> {
  const admin = requireAdminClient("revoke_token");
  const { error } = await admin
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
    Sentry.captureException(new Error("Plaid connection revocation persistence failed"), {
      tags: {
        area: "fund",
        provider: "plaid",
        operation: "revoke_token",
        code: "store_write_failed",
      },
    });
    throw new PlaidConnectionStoreUnavailableError();
  }
}
