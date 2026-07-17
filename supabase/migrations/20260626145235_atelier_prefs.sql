-- Per-user singleton row holding which Atelier pinned-resource entries the
-- user has starred. Mirrors the nutrition_protocol persistence pattern.
-- `pins` is a small bounded Record<string, boolean> keyed "langKey:index",
-- matching AtelierModule.tsx's in-memory shape exactly.
create table if not exists public.atelier_prefs (
  user_id uuid primary key references auth.users (id) on delete cascade,
  pins jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.atelier_prefs enable row level security;

drop policy if exists "atelier_prefs_select_own" on public.atelier_prefs;
create policy "atelier_prefs_select_own" on public.atelier_prefs
  for select using (auth.uid() = user_id);

drop policy if exists "atelier_prefs_insert_own" on public.atelier_prefs;
create policy "atelier_prefs_insert_own" on public.atelier_prefs
  for insert with check (auth.uid() = user_id);

drop policy if exists "atelier_prefs_update_own" on public.atelier_prefs;
create policy "atelier_prefs_update_own" on public.atelier_prefs
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "atelier_prefs_delete_own" on public.atelier_prefs;
create policy "atelier_prefs_delete_own" on public.atelier_prefs
  for delete using (auth.uid() = user_id);
