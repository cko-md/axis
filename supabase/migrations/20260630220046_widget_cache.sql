-- WID-DATA-1: Supabase-backed cache for widget runtime states.
-- Additive only. Runtime reads/writes are handled by the widget batch/cache flow.

create table if not exists public.widget_cache (
  user_id uuid not null references auth.users (id) on delete cascade,
  widget_id text not null,
  cache_key text not null,
  status text not null default 'stale' check (
    status in (
      'fresh',
      'live',
      'loading',
      'refreshing',
      'stale',
      'error',
      'empty',
      'disconnected',
      'setup_required',
      'lab',
      'disabled'
    )
  ),
  value text,
  hint text,
  raw jsonb not null default '{}'::jsonb,
  error jsonb,
  fetched_at timestamptz not null default now(),
  expires_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, widget_id, cache_key)
);

alter table public.widget_cache enable row level security;

create policy "widget_cache_select_own"
  on public.widget_cache for select using (auth.uid() = user_id);

create policy "widget_cache_insert_own"
  on public.widget_cache for insert with check (auth.uid() = user_id);

create policy "widget_cache_update_own"
  on public.widget_cache for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "widget_cache_delete_own"
  on public.widget_cache for delete using (auth.uid() = user_id);

create index if not exists idx_widget_cache_user_expires
  on public.widget_cache (user_id, expires_at);

comment on table public.widget_cache is
  'Per-user last-known widget states for cache-first Console loading.';

comment on column public.widget_cache.raw is
  'Normalized provider payload safe for the owning user to read; no secrets or raw OAuth payloads.';

comment on column public.widget_cache.error is
  'Structured, sanitized widget error metadata. Do not store tokens, private content, or raw provider responses.';
