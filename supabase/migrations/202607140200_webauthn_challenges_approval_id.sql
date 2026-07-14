-- 202607140200_webauthn_challenges_approval_id.sql
-- Step-up hardening: bind a WebAuthn step-up challenge to the specific approval
-- it authorizes, so a completed assertion can't be replayed against a different
-- approval (even one owned by the same user). Nullable + additive; login and
-- registration challenges leave it null. Rows are ephemeral (5-min TTL), so no
-- FK is added. Applied + verified on the live project.
alter table public.webauthn_challenges
  add column if not exists approval_id uuid;
