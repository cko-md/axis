-- Cache normalized inbox-list metadata only. Message bodies, attachment bytes,
-- OAuth payloads, and provider response bodies must never be stored here.
create table if not exists public.mail_message_cache (
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null check (provider in ('gmail', 'outlook')),
  transport text not null check (transport in ('direct', 'composio')),
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
  primary key (user_id, provider, transport, account_ref, provider_message_id),
  check (
    (transport = 'composio' and connected_account_id is not null)
    or (transport = 'direct' and connected_account_id is null)
  )
);

create index if not exists idx_mail_message_cache_inbox
  on public.mail_message_cache (user_id, received_at desc nulls last, provider_message_id);

create index if not exists idx_mail_message_cache_account_generation
  on public.mail_message_cache (user_id, provider, transport, account_ref, sync_generation);

alter table public.mail_message_cache enable row level security;

drop policy if exists "mail_message_cache_select_own" on public.mail_message_cache;
drop policy if exists "mail_message_cache_insert_own" on public.mail_message_cache;
drop policy if exists "mail_message_cache_update_own" on public.mail_message_cache;
drop policy if exists "mail_message_cache_delete_own" on public.mail_message_cache;

create policy "mail_message_cache_select_own"
  on public.mail_message_cache for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "mail_message_cache_insert_own"
  on public.mail_message_cache for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "mail_message_cache_update_own"
  on public.mail_message_cache for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "mail_message_cache_delete_own"
  on public.mail_message_cache for delete to authenticated
  using ((select auth.uid()) = user_id);

revoke all on table public.mail_message_cache from anon;
grant select, insert, update, delete on table public.mail_message_cache to authenticated;

create table if not exists public.integration_sync_state (
  user_id uuid not null references auth.users (id) on delete cascade,
  domain text not null check (domain in ('mail')),
  provider text not null check (provider in ('gmail', 'outlook')),
  transport text not null check (transport in ('direct', 'composio')),
  account_ref text not null,
  account_label text not null,
  last_status text not null check (last_status in ('success', 'error')),
  last_attempted_at timestamptz not null,
  last_synced_at timestamptz,
  last_error_code text,
  sync_generation uuid,
  updated_at timestamptz not null default now(),
  primary key (user_id, domain, provider, transport, account_ref),
  check (
    (last_status = 'success' and last_synced_at is not null and last_error_code is null)
    or (last_status = 'error' and last_error_code is not null)
  )
);

create index if not exists idx_integration_sync_state_domain
  on public.integration_sync_state (user_id, domain, updated_at desc);

alter table public.integration_sync_state enable row level security;

drop policy if exists "integration_sync_state_select_own" on public.integration_sync_state;
drop policy if exists "integration_sync_state_insert_own" on public.integration_sync_state;
drop policy if exists "integration_sync_state_update_own" on public.integration_sync_state;
drop policy if exists "integration_sync_state_delete_own" on public.integration_sync_state;

create policy "integration_sync_state_select_own"
  on public.integration_sync_state for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "integration_sync_state_insert_own"
  on public.integration_sync_state for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "integration_sync_state_update_own"
  on public.integration_sync_state for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "integration_sync_state_delete_own"
  on public.integration_sync_state for delete to authenticated
  using ((select auth.uid()) = user_id);

revoke all on table public.integration_sync_state from anon;
grant select, insert, update, delete on table public.integration_sync_state to authenticated;

comment on table public.mail_message_cache is
  'Owner-scoped normalized inbox metadata cache. Never store message bodies, attachment bytes, OAuth payloads, or raw provider responses.';
comment on table public.integration_sync_state is
  'Owner-scoped integration refresh outcome metadata with normalized error codes only.';
