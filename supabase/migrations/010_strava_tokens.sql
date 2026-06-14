-- 009_strava_tokens.sql
-- Persists Strava OAuth tokens per user for the Vitality module.
-- DO NOT APPLY blindly — review against the live project before running.
-- Tokens are also cached in httpOnly cookies (short-lived); this table provides
-- durable refresh-token storage so tokens survive across browser sessions.

create table if not exists public.user_strava_tokens (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  access_token text not null,
  refresh_token text not null,
  expires_at   timestamptz not null,
  athlete_id   bigint,
  athlete_name text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (user_id)
);

alter table public.user_strava_tokens enable row level security;

create policy "strava_tokens_select_own"
  on public.user_strava_tokens for select using (auth.uid() = user_id);
create policy "strava_tokens_insert_own"
  on public.user_strava_tokens for insert with check (auth.uid() = user_id);
create policy "strava_tokens_update_own"
  on public.user_strava_tokens for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "strava_tokens_delete_own"
  on public.user_strava_tokens for delete using (auth.uid() = user_id);

create index if not exists idx_user_strava_tokens_user on public.user_strava_tokens (user_id);
