-- Generic per-user settings store: one row per (user, key), jsonb value.
--
-- Purpose: client preferences that previously lived only in localStorage
-- (sidebar nav customization, notes folders, URL modules/boards, web viewer
-- favorites, vitality prefs, companion focus) survive re-logins, new devices,
-- and app updates. Feature-specific singleton tables (user_preferences,
-- atelier_prefs, ...) stay as they are; this table is for small per-feature
-- blobs that don't warrant their own table.
create table if not exists public.user_settings (
  user_id uuid not null references auth.users(id) on delete cascade,
  key text not null check (char_length(key) between 1 and 128),
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

alter table public.user_settings enable row level security;

-- Initplan-wrapped auth.uid() per 20260621232829_fix_rls_auth_initplan_perf.
create policy user_settings_select_own on public.user_settings
  for select using ((select auth.uid()) = user_id);
create policy user_settings_insert_own on public.user_settings
  for insert with check ((select auth.uid()) = user_id);
create policy user_settings_update_own on public.user_settings
  for update using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy user_settings_delete_own on public.user_settings
  for delete using ((select auth.uid()) = user_id);
