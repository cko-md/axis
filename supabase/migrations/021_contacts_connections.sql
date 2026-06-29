create table if not exists public.contacts_connections (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  provider    text not null default 'google',
  email       text,
  access_token_enc  text,
  refresh_token_enc text,
  expires_at  timestamptz,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

alter table public.contacts_connections enable row level security;

create policy "owner only" on public.contacts_connections
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create unique index if not exists idx_contacts_connections_user_provider
  on public.contacts_connections (user_id, provider);
