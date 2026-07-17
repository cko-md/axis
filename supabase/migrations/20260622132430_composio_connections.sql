create table if not exists public.composio_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  toolkit text not null,
  connected_account_id text not null,
  auth_config_id text not null,
  status text not null default 'INITIALIZING',
  account_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, toolkit, connected_account_id)
);

create index if not exists idx_composio_connections_user_id on public.composio_connections (user_id);
create index if not exists idx_composio_connections_toolkit on public.composio_connections (toolkit);

alter table public.composio_connections enable row level security;

create policy "composio_connections_select_own" on public.composio_connections
  for select using ((select auth.uid()) = user_id);
create policy "composio_connections_insert_own" on public.composio_connections
  for insert with check ((select auth.uid()) = user_id);
create policy "composio_connections_update_own" on public.composio_connections
  for update using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "composio_connections_delete_own" on public.composio_connections
  for delete using ((select auth.uid()) = user_id);
