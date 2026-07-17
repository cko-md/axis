-- 20260716002727_make_delivery_outbox.sql
-- BACKFILL: applied live via MCP, .sql never committed (repo/prod drift,
-- discovered 2026-07-17). Reconstructed from live schema on 2026-07-17.
--
-- Durable outbox for outbound integration deliveries (e.g. Make.com
-- webhooks): a row per delivery attempt, encrypted payload at rest, claimed
-- via claim_token/locked_at for safe concurrent dispatch, deduped per
-- (user_id, provider, dedupe_key_hash). Writes are service-role only
-- (dispatcher runs server-side); users can only read their own rows.

create table if not exists public.integration_delivery_outbox (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null,
  event_type text not null,
  dedupe_key_hash text not null,
  payload_ciphertext text not null,
  status text not null default 'pending',
  attempt_count integer not null default 0,
  last_error_code text,
  last_http_status integer,
  claim_token uuid,
  locked_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.integration_delivery_outbox enable row level security;

drop policy if exists "integration_delivery_outbox_select_own" on public.integration_delivery_outbox;
create policy "integration_delivery_outbox_select_own" on public.integration_delivery_outbox for select using ((select auth.uid()) = user_id);
-- No insert/update/delete policy: the outbox is written and dispatched by the
-- service-role client only.

create unique index if not exists integration_delivery_outbox_user_id_provider_dedupe_key_has_key
  on public.integration_delivery_outbox (user_id, provider, dedupe_key_hash);

create index if not exists idx_integration_delivery_outbox_user_status
  on public.integration_delivery_outbox (user_id, status, updated_at desc);

create index if not exists idx_integration_delivery_outbox_stale_claims
  on public.integration_delivery_outbox (status, locked_at)
  where status = 'pending' and claim_token is not null;
