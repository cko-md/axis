-- CAL-3: per-user last-known external calendar events, for cache-first
-- Schedule loading. Mirrors widget_cache's shape/RLS exactly
-- (202606302157_widget_cache.sql) — one row per (user, source), holding the
-- full normalized event list for the most recently fetched range plus
-- freshness/error metadata so the client can render instantly from cache
-- and revalidate live in the background.

create table if not exists public.calendar_event_cache (
  user_id uuid not null references auth.users (id) on delete cascade,
  source text not null check (source in ('google', 'outlook')),
  transport text not null default 'direct' check (transport in ('direct', 'composio')),
  range_start timestamptz not null,
  range_end timestamptz not null,
  events jsonb not null default '[]'::jsonb,
  error jsonb,
  fetched_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, source)
);

alter table public.calendar_event_cache enable row level security;

create policy "calendar_event_cache_select_own"
  on public.calendar_event_cache for select using (auth.uid() = user_id);

create policy "calendar_event_cache_insert_own"
  on public.calendar_event_cache for insert with check (auth.uid() = user_id);

create policy "calendar_event_cache_update_own"
  on public.calendar_event_cache for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "calendar_event_cache_delete_own"
  on public.calendar_event_cache for delete using (auth.uid() = user_id);

comment on table public.calendar_event_cache is
  'Per-user last-known external (Google/Outlook) calendar events, for cache-first Schedule loading.';

comment on column public.calendar_event_cache.events is
  'Normalized ExternalCalendarEvent[] safe for the owning user to read; titles/attendees/locations only, never tokens or raw OAuth payloads.';

comment on column public.calendar_event_cache.error is
  'Structured, sanitized fetch-error metadata (source/transport/code/message). Do not store tokens or raw provider responses.';
