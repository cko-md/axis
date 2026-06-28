import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import { getPublicEnv, optionalEnv } from "@/lib/env";

/**
 * Service-role Supabase client for trusted server-side operations that must
 * bypass RLS — specifically the pre-authentication passkey (WebAuthn) flow,
 * which reads `user_passkeys` and manages `webauthn_challenges` before any
 * user session exists.
 *
 * Returns null when SUPABASE_SERVICE_ROLE_KEY is not configured, so callers can
 * fall back to the anon client. This preserves current behaviour until the key
 * is set and `webauthn_challenges` RLS is enabled (migration 019). Once the key
 * is present, these operations run as service-role and the table can be locked
 * to service-role-only (RLS on, no policies).
 *
 * NEVER import this into a client component or expose the key to the browser.
 */
export function createAdminClient(): SupabaseClient | null {
  const serviceKey = optionalEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!serviceKey) return null;
  const env = getPublicEnv();
  return createSupabaseClient(env.NEXT_PUBLIC_SUPABASE_URL, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
