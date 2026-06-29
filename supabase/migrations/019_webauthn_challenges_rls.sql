-- 019_webauthn_challenges_rls.sql
-- Lock webauthn_challenges to service-role-only access.
--
-- The table is touched exclusively by the passkey routes
-- (/api/auth/passkey/{register,authenticate}) via the service-role client
-- (createAdminClient), which bypasses RLS. Enabling RLS with NO policies fully
-- denies the anon and authenticated roles — closing the prior exposure where
-- anyone with the anon key could read or modify pending WebAuthn challenges.
--
-- PREREQUISITE: SUPABASE_SERVICE_ROLE_KEY must be set in the deployment env.
-- Without it, the passkey routes fall back to the anon client and these queries
-- will be blocked. Set the key before applying this migration.

alter table public.webauthn_challenges enable row level security;
