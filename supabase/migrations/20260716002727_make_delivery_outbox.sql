-- Phase 10.14: durable, encrypted Make notification delivery outbox.
--
-- Payload ciphertext may contain recipient and private financial context. Owners
-- may inspect delivery metadata through RLS, but only trusted server code can
-- insert/update rows or access the decrypted payload. No delete policy keeps the
-- delivery history auditable.

create table if not exists public.integration_delivery_outbox (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null check (provider in ('make')),
  event_type text not null check (event_type in (
    'daily_brief', 'weekly_recap', 'bill_reminder', 'budget_alert',
    'anomaly_alert', 'subscription_audit'
  )),
  dedupe_key_hash text not null check (dedupe_key_hash ~ '^[0-9a-f]{64}$'),
  payload_ciphertext text not null,
  status text not null default 'pending'
    check (status in ('pending', 'delivered', 'failed', 'dead_letter')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_error_code text,
  last_http_status integer check (last_http_status between 100 and 599),
  claim_token uuid,
  locked_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint integration_delivery_outbox_claim_pair_check check (
    (claim_token is null and locked_at is null)
    or (claim_token is not null and locked_at is not null)
  ),
  constraint integration_delivery_outbox_claim_status_check check (
    claim_token is null or status = 'pending'
  ),
  constraint integration_delivery_outbox_delivered_check check (
    (status = 'delivered' and delivered_at is not null)
    or (status <> 'delivered' and delivered_at is null)
  ),
  unique (user_id, provider, dedupe_key_hash)
);

alter table public.integration_delivery_outbox enable row level security;

drop policy if exists "integration_delivery_outbox_select_own"
  on public.integration_delivery_outbox;
create policy "integration_delivery_outbox_select_own"
  on public.integration_delivery_outbox for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- RLS limits rows; column grants separately prevent direct REST clients from
-- selecting encrypted payloads, owner IDs, dedupe hashes, or claim tokens.
revoke all on table public.integration_delivery_outbox from anon, authenticated;
grant select (
  id, provider, event_type, status, attempt_count, last_error_code,
  last_http_status, locked_at, delivered_at, created_at, updated_at
) on table public.integration_delivery_outbox to authenticated;
grant all on table public.integration_delivery_outbox to service_role;

-- Deliberately no insert/update/delete policies or authenticated grants. The
-- operator invokes a server route, which verifies ownership and uses the
-- service role to claim/finalize a delivery. Browsers cannot forge state.

create index if not exists idx_integration_delivery_outbox_user_status
  on public.integration_delivery_outbox (user_id, status, updated_at desc);

create index if not exists idx_integration_delivery_outbox_stale_claims
  on public.integration_delivery_outbox (status, locked_at)
  where status = 'pending' and claim_token is not null;

comment on table public.integration_delivery_outbox is
  'Encrypted external-communication outbox. Owner-readable metadata; server-only mutation; no autonomous replay.';
