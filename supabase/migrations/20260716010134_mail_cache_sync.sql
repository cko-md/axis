-- 20260716010134_mail_cache_sync.sql
-- BACKFILL: applied live via MCP, .sql never committed (repo/prod drift,
-- discovered 2026-07-17). Reconstructed from live schema on 2026-07-17.
--
-- mail_message_cache: server-side cache of fetched mail messages per
-- provider/transport/account, keyed by a sync_generation so a full resync
-- can be told apart from a stale partial one.
-- integration_sync_state: last-attempt/last-success status per
-- (user, domain, provider, transport, account) — the general-purpose sync
-- bookkeeping table this and other integrations (mail, calendar, contacts)
-- read to show connection health. Both are service-role write only; users
-- read their own rows.

create table if not exists public.mail_message_cache (
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null,
  transport text not null,
  account_ref text not null,
  account_email text not null,
  connected_account_id text,
  provider_message_id text not null,
  thread_id text not null default '',
  sender text not null default '',
  subject text not null default '',
  snippet text not null default '',
  message_date text not null,
  received_at timestamptz,
  is_unread boolean not null default false,
  sync_generation uuid not null,
  fetched_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, provider, transport, account_ref, provider_message_id)
);

alter table public.mail_message_cache enable row level security;

drop policy if exists "mail_message_cache_select_own" on public.mail_message_cache;
create policy "mail_message_cache_select_own" on public.mail_message_cache for select using ((select auth.uid()) = user_id);

create index if not exists idx_mail_message_cache_inbox
  on public.mail_message_cache (user_id, received_at desc nulls last, provider_message_id);

create index if not exists idx_mail_message_cache_account_generation
  on public.mail_message_cache (user_id, provider, transport, account_ref, sync_generation);

create table if not exists public.integration_sync_state (
  user_id uuid not null references auth.users (id) on delete cascade,
  domain text not null,
  provider text not null,
  transport text not null,
  account_ref text not null,
  account_label text not null,
  last_status text not null,
  last_attempted_at timestamptz not null,
  last_synced_at timestamptz,
  last_error_code text,
  sync_generation uuid,
  updated_at timestamptz not null default now(),
  primary key (user_id, domain, provider, transport, account_ref)
);

alter table public.integration_sync_state enable row level security;

drop policy if exists "integration_sync_state_select_own" on public.integration_sync_state;
create policy "integration_sync_state_select_own" on public.integration_sync_state for select using ((select auth.uid()) = user_id);
drop policy if exists "integration_sync_state_insert_own" on public.integration_sync_state;
create policy "integration_sync_state_insert_own" on public.integration_sync_state for insert with check ((select auth.uid()) = user_id);
drop policy if exists "integration_sync_state_update_own" on public.integration_sync_state;
create policy "integration_sync_state_update_own" on public.integration_sync_state for update using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists "integration_sync_state_delete_own" on public.integration_sync_state;
create policy "integration_sync_state_delete_own" on public.integration_sync_state for delete using ((select auth.uid()) = user_id);

create index if not exists idx_integration_sync_state_domain
  on public.integration_sync_state (user_id, domain, updated_at desc);
