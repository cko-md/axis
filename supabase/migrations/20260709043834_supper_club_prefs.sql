-- Supper Club: persist diet, saved recipe ids, and user-added recipes per owner.
create table if not exists public.supper_club_prefs (
  user_id uuid primary key references auth.users (id) on delete cascade,
  diet text not null default 'high-protein',
  saved_ids jsonb not null default '[]'::jsonb,
  custom_recipes jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.supper_club_prefs enable row level security;

drop policy if exists "supper_club_prefs_select_own" on public.supper_club_prefs;
create policy "supper_club_prefs_select_own"
  on public.supper_club_prefs for select
  using (auth.uid() = user_id);

drop policy if exists "supper_club_prefs_insert_own" on public.supper_club_prefs;
create policy "supper_club_prefs_insert_own"
  on public.supper_club_prefs for insert
  with check (auth.uid() = user_id);

drop policy if exists "supper_club_prefs_update_own" on public.supper_club_prefs;
create policy "supper_club_prefs_update_own"
  on public.supper_club_prefs for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "supper_club_prefs_delete_own" on public.supper_club_prefs;
create policy "supper_club_prefs_delete_own"
  on public.supper_club_prefs for delete
  using (auth.uid() = user_id);
