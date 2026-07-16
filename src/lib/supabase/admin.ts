import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import { getPublicEnv, optionalEnv } from "@/lib/env";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Service-role Supabase client for trusted server-side operations that must
 * bypass RLS — specifically the pre-authentication passkey (WebAuthn) flow,
 * which reads `user_passkeys` and manages `webauthn_challenges` before any
 * user session exists.
 *
 * Returns null when SUPABASE_SERVICE_ROLE_KEY is not configured. Trusted
 * mutation and pre-authentication callers must fail closed with a visible
 * configured/not-configured response; they must never fall back to an anon or
 * session client for service-only operations.
 *
 * NEVER import this into a client component or expose the key to the browser.
 */
export function createAdminClient(): SupabaseClient<Database> | null {
  const serviceKey = optionalEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!serviceKey) return null;
  const env = getPublicEnv();
  return createSupabaseClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
